/**
 * @mstack/reviewer — review-agent.ts — the Claude agent pipeline that turns a
 * `ReviewRequest` into a `ReviewResult` (research/06-architecture.md §3.1, §7
 * W3-T2). This is the flagship claim-drift reviewer's live path.
 *
 * PIPELINE (§3.1, FacTool-5-stage shape, all TypeScript on the live path):
 *   1. segment       (TS)              — asset text -> sentence spans.
 *   2. pre-scan       (TS, rules.ts)    — `scanDeterministic` -> high-confidence
 *                                         priors (`detectedBy:'deterministic'`).
 *   3. extract        (Claude/Sonnet)   — `runAgent` -> atomic claims + `checkWorthy`
 *                                         + `category`.
 *   4. retrieve       (TS)              — per check-worthy claim, `corpus.retrieve`
 *                                         top-k approved-messaging passages.
 *   5. judge & ground (Claude/Opus)     — `runAgent(modelFor("reviewerJudge"))`
 *                                         with passages + rules + priors in the
 *                                         context pack -> per claim supported |
 *                                         drifted | unsupported, cite a
 *                                         `supportingPassageId` or null, set
 *                                         `severity` + a targeted `recommendedChange`.
 *   5a. NLI backstop   (TS, nli-backstop.ts) — WAVE B2 addition (research/
 *                                         10-sota-integration-design.md §2.2):
 *                                         every judge finding gets a grounded,
 *                                         model-independent second opinion. On
 *                                         DISAGREEMENT the finding is
 *                                         re-attributed `detectedBy:'nli'` +
 *                                         `needsReview:true`. Default `noopNliBackstop`
 *                                         always agrees -- fully offline, no-op.
 *   5b. merge          (TS)              — the deterministic priors are merged in
 *                                         (deduped by category+quote); the priors
 *                                         are authoritative for the mechanical
 *                                         categories, so they survive even if the
 *                                         judge under-reports.
 *   6. score & emit    (TS)             — `changesCount` = count of REQUIRED
 *                                         findings; `score` = core
 *                                         `scoreForChanges(changesCount)`; verdict
 *                                         RETURNED iff changesCount > 0 else APPROVED.
 *
 * MECHANICAL GUARDRAIL #1 (reviewer != generator, §8 #1): the output is a
 * `ReviewResult` — findings + a reviewer summary NOTE + a rubric score. There
 * is NO field for generated marketing prose, and every `recommendedChange` is
 * a targeted INSTRUCTION ("cite a published source for this figure, or remove
 * it"), never a drafted replacement paragraph. The two drafts this module
 * produces (`buildReviewDrafts`) are PROCESS artifacts — a partner-facing
 * findings email and an annotated review export — not regenerated content.
 *
 * OFFLINE-TESTABLE: the Anthropic client (`deps.client`) and the embedder
 * (injected into `deps.corpus`, e.g. `FakeEmbedder`) are both injectable, so
 * the whole pipeline runs with zero network in tests (see review-agent.test.ts).
 * Prompt hygiene per docs/build-conventions.md + §3.0: every `system` prompt is
 * job-as-function, calm, no identity inflation — it matters most in the reviewer.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  ClaimCategory,
  Draft,
  FindingDraft,
  Guideline,
  ReviewRequest,
  ReviewResult,
  modelFor,
  scoreForChanges,
} from "@mstack/core";
import type { GuidelineCorpus, RetrievedPassage } from "@mstack/core";
import { runAgent } from "@mstack/agents";
import type { AnthropicClient, ContextBlock } from "@mstack/agents";

import { scanDeterministic } from "./rules.js";
import { noopNliBackstop } from "./nli-backstop.js";
import type { NliBackstop } from "./nli-backstop.js";

/* ─────────────────────────────── deps ─────────────────────────────────── */

/** Everything `reviewAsset` needs injected. `corpus` supplies both the
 *  deterministic rule rows (`rules()`) and the RAG evidence (`retrieve()`);
 *  the embedder is injected INTO the corpus (so `FakeEmbedder` keeps tests
 *  offline). `client` is the injectable Anthropic client (omit for real runs
 *  → built from `ANTHROPIC_API_KEY`). */
export interface ReviewAgentDeps {
  corpus: GuidelineCorpus;
  client?: AnthropicClient;
  /** top-k passages retrieved per check-worthy claim (default 5). */
  retrieveK?: number;
  /** model-id overrides; default to the core `modelFor` routing (extractor →
   *  sonnet reasoner, judge → opus reviewerJudge). */
  models?: { extractor?: string; judge?: string };
  /** grounded-NLI second opinion on every judge finding (research/
   *  10-sota-integration-design.md §2.2, Wave B2). Default `noopNliBackstop` —
   *  agrees with the judge unconditionally, fully offline, no sidecar. Inject
   *  `hhemBackstop` (nli-backstop.ts) to turn on the real HHEM sidecar. */
  nliBackstop?: NliBackstop;
}

/** Deps for `authorGuidelines` — just the injectable client + optional model. */
export interface AuthorGuidelinesDeps {
  client?: AnthropicClient;
  /** default `modelFor("guidelineAuthor")` (sonnet). */
  model?: string;
}

const DEFAULT_RETRIEVE_K = 5;

/* ───────────────────────── agent I/O schemas ──────────────────────────── */

/** Step-3 claim-extraction output (Claude/Sonnet). Atomic claim + whether it
 *  is check-worthy + a best-effort category (null when it maps to none). */
const ExtractedClaim = z.object({
  text: z.string().min(1),
  category: ClaimCategory.nullable().default(null),
  checkWorthy: z.boolean(),
});
type ExtractedClaim = z.infer<typeof ExtractedClaim>;

const ClaimExtraction = z.object({ claims: z.array(ExtractedClaim) });

/** Step-5 judge output (Claude/Opus): the findings it grounds against the
 *  retrieved passages + rules, plus a one-paragraph reviewer NOTE (not
 *  content). Findings are core `FindingDraft`s — the schema itself forbids a
 *  generated-prose field (guardrail #1). */
const JudgeResult = z.object({
  findings: z.array(FindingDraft),
  summary: z.string(),
});

/** `authorGuidelines` output: the initial corpus as core `Guideline[]`. */
const AuthoredCorpus = z.object({ guidelines: z.array(Guideline) });

/* ──────────────────────────── system prompts ──────────────────────────── */

const EXTRACT_SYSTEM =
  "You extract atomic, check-worthy claims from a partner marketing asset for a compliance review. " +
  "For each claim return: its text (verbatim where possible); whether it is check-worthy (a factual or " +
  "marketing assertion that could drift from approved messaging — an outcome/ROI claim, a numeric metric, " +
  "a superlative, a spokesperson quote, a roadmap/product statement, or a badge/tier claim); and, when it " +
  "clearly maps to one, its category from: guaranteed_outcome, uncited_quantitative, unapproved_superlative, " +
  "unapproved_spokesperson_quote, roadmap_disclosure, badge_tier_misuse — otherwise null. " +
  "You do not judge, rewrite, expand, or generate content. Return only JSON matching the required schema.";

const JUDGE_SYSTEM =
  "You are a partner-content compliance reviewer. Your only job: compare a submitted asset against the " +
  "approved partner-content guidelines (your north star) and report where it drifts. You do not write, " +
  "rewrite, expand, or generate marketing content. A recommendedChange is a short INSTRUCTION to the partner " +
  '(e.g. "cite a published source for this figure, or remove it"), never a drafted replacement paragraph. ' +
  "Use the provided brand rules and the retrieved approved-messaging passages. For each check-worthy claim " +
  "decide: is it supported by a retrieved passage (cite its id in supportingPassageId) or unsupported (null)? " +
  "Categorize every violation into exactly one of the six categories, set its severity, and write a targeted " +
  "recommendedChange. The deterministic pre-scan priors supplied in context are high-confidence and are already " +
  "recorded — do not restate a prior you agree with; add only the findings the mechanical scan cannot catch " +
  "(novel phrasing, implied claims, unsupported assertions). Return only JSON matching the schema: findings plus " +
  "a one-paragraph reviewer summary note (a review note, not marketing copy).";

const AUTHOR_SYSTEM =
  "You produce the initial partner-content guideline corpus from a short brand brief. Output structured " +
  "Guideline rows covering the six claim-drift categories as rule rows — a guarantee/outcome lexicon " +
  "(type:lexicon), a banned-superlative lexicon (type:lexicon), an uncited-quantitative rule (type:lexicon), " +
  "a roadmap/codename denylist (type:denylist), a spokesperson allowlist (type:allowlist), and a tier→badge " +
  "map (type:tier_map) — plus a starter set of approved-messaging passages (type:approved_messaging). " +
  "Each row needs a stable id, a category, a type, content prose, a severity (low|medium|high), a source, and " +
  'version "1". You author RULES and approved messaging; you do not review a specific asset here. Return only ' +
  "JSON matching the required schema.";

const RUBRIC_TEXT =
  "Required changes → review score: 0 required → 5 (publish-ready); 1-2 → 4; 3 → 3; 4 → 2; 5 or more → 1. " +
  "changesCount counts REQUIRED findings only. This score is computed deterministically from the merged findings; " +
  "you do not need to compute it — focus on the findings themselves.";

/* ─────────────────────────── step 1: segment ──────────────────────────── */

export interface AssetSegment {
  text: string;
  span: { start: number; end: number };
}

/** Split the asset into sentence-ish segments with character offsets. Used to
 *  give the extractor a segmented view (and offsets available for span
 *  attribution). Deliberately simple + offline — not a full NLP sentence
 *  splitter; the mechanical categories rules.ts owns don't need one, and the
 *  judge quotes verbatim from the full asset text it also receives. */
export function segmentAsset(content: string): { segments: AssetSegment[]; numbered: string } {
  const segments: AssetSegment[] = [];
  const re = /\S[^.!?\n]*[.!?]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[0] ?? "";
    const text = raw.trim();
    if (text.length === 0) continue;
    segments.push({ text, span: { start: m.index, end: m.index + raw.length } });
  }
  const numbered = segments.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
  return { segments, numbered };
}

/* ─────────────────────── context-pack assembly ────────────────────────── */

function rulesBlock(rules: Guideline[]): string {
  if (rules.length === 0) return "(no rule rows in the corpus)";
  return rules
    .map((r) => `[${r.id} · ${r.category} · ${r.type} · ${r.severity}] ${r.content}`)
    .join("\n");
}

function tierBlock(tier: ReviewRequest["partnerTier"], rules: Guideline[]): string {
  const tierRows = rules.filter((r) => r.type === "tier_map");
  const map = tierRows.length > 0 ? tierRows.map((r) => r.content).join("\n") : "(no tier_map rows)";
  return `Partner tier under review: ${tier}\n\nTier → badge map:\n${map}`;
}

interface ClaimEvidence {
  claim: ExtractedClaim;
  passages: RetrievedPassage[];
}

function evidenceBlock(evidence: ClaimEvidence[]): string {
  if (evidence.length === 0) return "(no check-worthy claims to ground)";
  return evidence
    .map(({ claim, passages }) => {
      const cat = claim.category ? ` (candidate category: ${claim.category})` : "";
      const lines =
        passages.length > 0
          ? passages
              .map((p) => `  - [${p.id} score=${p.score.toFixed(3)}] ${p.content}`)
              .join("\n")
          : "  (no supporting passage retrieved — likely unsupported)";
      return `CLAIM: ${claim.text}${cat}\n${lines}`;
    })
    .join("\n\n");
}

/* ─────────────────────── steps 3-5 (Claude calls) ─────────────────────── */

async function extractClaims(req: ReviewRequest, deps: ReviewAgentDeps): Promise<ExtractedClaim[]> {
  const { numbered } = segmentAsset(req.content);
  const out = await runAgent({
    model: deps.models?.extractor ?? modelFor("reasoner"),
    system: EXTRACT_SYSTEM,
    input: {
      partnerTier: req.partnerTier,
      contentType: req.contentType,
      contentTitle: req.contentTitle,
    },
    outSchema: ClaimExtraction,
    contextPack: [{ label: "ASSET (segmented into sentences)", content: numbered }],
    client: deps.client,
  });
  // runAgent's TOut infers the zod *input* type (defaults optional); re-coerce to the
  // parsed output type. Idempotent — runAgent already validated the value.
  return ClaimExtraction.parse(out).claims;
}

async function retrieveForClaims(
  claims: ExtractedClaim[],
  deps: ReviewAgentDeps,
): Promise<ClaimEvidence[]> {
  const k = deps.retrieveK ?? DEFAULT_RETRIEVE_K;
  const evidence: ClaimEvidence[] = [];
  for (const claim of claims) {
    if (!claim.checkWorthy) continue;
    const passages = await deps.corpus.retrieve(claim.text, k);
    evidence.push({ claim, passages });
  }
  return evidence;
}

async function judge(
  req: ReviewRequest,
  priors: FindingDraft[],
  rules: Guideline[],
  evidence: ClaimEvidence[],
  deps: ReviewAgentDeps,
): Promise<z.infer<typeof JudgeResult>> {
  const contextPack: ContextBlock[] = [
    { label: "ASSET UNDER REVIEW", content: req.content },
    { label: "PARTNER TIER + BADGE MAP", content: tierBlock(req.partnerTier, rules) },
    { label: "BRAND RULES", content: rulesBlock(rules) },
    { label: "RETRIEVED APPROVED MESSAGING (per claim)", content: evidenceBlock(evidence) },
    {
      label: "DETERMINISTIC PRE-SCAN PRIORS (high-confidence; already recorded)",
      content: JSON.stringify(priors, null, 2),
    },
    { label: "RUBRIC", content: RUBRIC_TEXT },
  ];
  return runAgent({
    model: deps.models?.judge ?? modelFor("reviewerJudge"),
    system: JUDGE_SYSTEM,
    input: {
      partnerId: req.partnerId,
      partnerTier: req.partnerTier,
      contentTitle: req.contentTitle,
      contentType: req.contentType,
    },
    outSchema: JudgeResult,
    contextPack,
    client: deps.client,
  });
}

/* ─────────────────── step 5a: grounded-NLI backstop (Wave B2) ─────────────────── */

/** A judge/prior `FindingDraft` plus an optional NLI-backstop flag (research/
 *  10-sota-integration-design.md §2.2, Wave B2). `needsReview` is present ONLY
 *  when the grounded-NLI backstop DISAGREED with the judge's implicit verdict
 *  (the judge treated the claim as a violation; the backstop finds it IS
 *  entailed by the best available passage) — absent entirely otherwise, so
 *  every existing consumer that only reads the original 8 `FindingDraft` keys
 *  is byte-for-byte unaffected. Additive-only: this does NOT change core's
 *  `FindingDraft` schema — guardrail #1 (no generated-prose field) is
 *  unaffected, `needsReview` is a boolean review-metadata flag. */
export const NliFindingDraft = FindingDraft.extend({ needsReview: z.boolean().optional() });
export type NliFindingDraft = z.infer<typeof NliFindingDraft>;

/** `ReviewResult` with `findings: NliFindingDraft[]` instead of core's
 *  `FindingDraft[]`, so the optional `needsReview` flag survives the final
 *  validation instead of being stripped by zod's default "strip unknown keys"
 *  behavior on core's stricter shape. Structurally still a `ReviewResult`
 *  (every consumer that only reads the core shape — e.g. `buildReviewDrafts`
 *  below — keeps working unchanged; TS structural typing accepts the wider
 *  finding shape wherever the narrower one is expected). */
export const ReviewResultWithNli = ReviewResult.extend({ findings: z.array(NliFindingDraft) });
export type ReviewResultWithNli = z.infer<typeof ReviewResultWithNli>;

/** Locates the best passage text to check a judge finding's claim against:
 *  the passage it actually cited (`supportingPassageId`) — the core backstop
 *  use case, double-checking a citation the judge relied on — or, for a fully
 *  unsupported finding (`supportingPassageId: null`), the top retrieved
 *  passage for whichever claim this finding's quote came from, so the
 *  backstop can independently double-check "was there really nothing." Falls
 *  back to `""` (nothing to compare against) when neither resolves; every
 *  `NliBackstop` impl (including the default `noopNliBackstop`) treats an
 *  empty passage the same as "no evidence." */
function findPassageForFinding(finding: FindingDraft, evidence: ClaimEvidence[]): string {
  if (finding.supportingPassageId) {
    for (const { passages } of evidence) {
      const hit = passages.find((p) => p.id === finding.supportingPassageId);
      if (hit) return hit.content;
    }
  }
  const quote = finding.quote.toLowerCase();
  const byClaim = evidence.find(({ claim }) => {
    const claimText = claim.text.toLowerCase();
    return quote.includes(claimText) || claimText.includes(quote);
  });
  return byClaim?.passages[0]?.content ?? "";
}

/**
 * Runs every judge finding through the grounded-NLI backstop (research/
 * 10-sota-integration-design.md §2.2, Wave B2). Every judge finding IS, by
 * this schema's construction, a claim the judge marked unsupported or drifted
 * (a claim the judge considers supported never becomes a finding at all — see
 * `JUDGE_SYSTEM` above), so no separate "which findings are unsupported/
 * drifted" filter is needed here — all of `judged.findings` qualify.
 *
 * On DISAGREEMENT (the backstop finds the claim IS entailed by the best
 * available passage, contradicting the judge) the finding is re-attributed
 * `detectedBy: "nli"` and flagged `needsReview: true` for a human to resolve.
 * On agreement — the default `noopNliBackstop`'s only possible outcome — the
 * finding is returned unchanged, so this step is a true no-op end to end
 * unless a real backstop is injected. Deterministic priors are NOT passed
 * through this step (mechanical categories, incl. `pii_leak`, are not
 * judge-produced claims to double-check).
 */
async function applyNliBackstop(
  findings: FindingDraft[],
  evidence: ClaimEvidence[],
  backstop: NliBackstop,
): Promise<NliFindingDraft[]> {
  const out: NliFindingDraft[] = [];
  for (const f of findings) {
    const passage = findPassageForFinding(f, evidence);
    const verdict = await backstop.entails(f.quote, passage);
    out.push(
      verdict.supported
        ? NliFindingDraft.parse({ ...f, detectedBy: "nli", needsReview: true })
        : NliFindingDraft.parse(f),
    );
  }
  return out;
}

/* ───────────────────────── step 5b: merge ─────────────────────────────── */

/** Deterministic priors ∪ NLI-checked judge findings, deduped by category +
 *  quote. Priors come first so a mechanical finding wins over a judge
 *  duplicate of the same violation (same key as rules.ts's own `dedupe`). The
 *  priors are authoritative for the mechanical categories: they survive even
 *  if the judge drops one. Priors never carry `needsReview` (they never go
 *  through `applyNliBackstop`); routing everything through `NliFindingDraft`
 *  here is just a uniform validation pass — the key is absent on every prior
 *  either way, identical to before this feature existed. */
function mergeFindings(priors: FindingDraft[], judged: NliFindingDraft[]): NliFindingDraft[] {
  const seen = new Set<string>();
  const out: NliFindingDraft[] = [];
  for (const f of [...priors, ...judged]) {
    const key = `${f.category} ${f.quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(NliFindingDraft.parse(f));
  }
  return out;
}

/* ───────────────────────────── reviewAsset ────────────────────────────── */

/**
 * The full reviewer pipeline (research/06-architecture.md §3.1). Given a
 * `ReviewRequest` + injected deps, returns a `ReviewResult` — findings, a
 * rubric score, a verdict, and a reviewer summary note. Reviews and tracks;
 * never generates content (guardrail #1).
 */
export async function reviewAsset(req: ReviewRequest, deps: ReviewAgentDeps): Promise<ReviewResultWithNli> {
  const request = ReviewRequest.parse(req); // validate inbound (§3.0)

  // 2. deterministic pre-scan → high-confidence priors
  const rules = await deps.corpus.rules();
  const priors = scanDeterministic(
    { content: request.content, partnerTier: request.partnerTier },
    rules,
  );

  // 3. claim extraction (Sonnet)
  const claims = await extractClaims(request, deps);

  // 4. retrieve top-k approved-messaging passages per check-worthy claim (TS)
  const evidence = await retrieveForClaims(claims, deps);

  // 5. judge & ground (Opus)
  const judged = await judge(request, priors, rules, evidence, deps);

  // 5a. grounded-NLI backstop — model-independent second opinion on every judge
  // finding (Wave B2). Default `noopNliBackstop`: fully offline, changes nothing.
  const nliChecked = await applyNliBackstop(judged.findings, evidence, deps.nliBackstop ?? noopNliBackstop);

  // 5b. merge the deterministic priors in
  const findings = mergeFindings(priors, nliChecked);

  // 6. score & emit — changesCount = required findings; score via the core rubric
  const changesCount = findings.filter((f) => f.required).length;
  const score = scoreForChanges(changesCount);
  const verdict = changesCount > 0 ? "RETURNED" : "APPROVED";

  return ReviewResultWithNli.parse({
    score,
    changesCount,
    verdict,
    findings,
    summary: judged.summary,
  });
}

/* ─────────────────────────── authorGuidelines ─────────────────────────── */

/**
 * Guideline-authoring helper (§3.1, "Saqib built the guidelines WITH Claude in
 * two minutes"). A Sonnet call that turns a short brand brief into the initial
 * corpus — the six-category rule-set (lexicons / allowlist / denylist /
 * tier-map) + a starter approved-messaging set — as core `Guideline[]`, ready
 * to load into `LanceCorpus.ingest()` + the rule tables. This is what makes the
 * stack usable on day one before a real corpus exists.
 */
export async function authorGuidelines(
  brandBrief: string,
  deps: AuthorGuidelinesDeps = {},
): Promise<Guideline[]> {
  const out = await runAgent({
    model: deps.model ?? modelFor("guidelineAuthor"),
    system: AUTHOR_SYSTEM,
    input: { brandBrief },
    outSchema: AuthoredCorpus,
    client: deps.client,
  });
  // Re-coerce to the parsed output type (Guideline defaults applied); idempotent.
  return AuthoredCorpus.parse(out).guidelines;
}

/* ─────────────────────────── buildReviewDrafts ────────────────────────── */

export interface BuildDraftsOptions {
  /** the persisted Review id these drafts reference; default a fresh uuid. */
  reviewId?: string;
  /** ISO timestamp for `createdAt`; default `now`. Injectable for deterministic tests. */
  now?: string;
  /** `Draft.createdBy`; default "reviewer". */
  createdBy?: string;
}

function partnerEmailBody(review: ReviewResult, req: ReviewRequest): string {
  const intro =
    review.verdict === "RETURNED"
      ? "Before this can be published, please address the required changes below:"
      : "This asset is publish-ready. Any optional notes are below.";
  const findingLines =
    review.findings.length > 0
      ? review.findings
          .map(
            (f, i) =>
              `${i + 1}. [${f.category}${f.required ? " · REQUIRED" : ""}] "${f.quote}"\n   → ${f.recommendedChange}`,
          )
          .join("\n\n")
      : "No findings — nothing to change.";
  return [
    `Hi ${req.partnerId} team,`,
    "",
    `We reviewed "${req.contentTitle}" (${req.contentType}). Verdict: ${review.verdict} — review score ${review.score}/5, ${review.changesCount} required change(s).`,
    "",
    intro,
    "",
    findingLines,
    "",
    `Reviewer note: ${review.summary}`,
    "",
    "These are review instructions only. Please make the edits on your side and resubmit — nothing has been sent or published on your behalf.",
    "",
    "— KLZ Partner Marketing (automated review; pending human approval)",
  ].join("\n");
}

function reviewExportBody(review: ReviewResult, req: ReviewRequest): string {
  const findingBlocks =
    review.findings.length > 0
      ? review.findings
          .map(
            (f, i) =>
              `#${i + 1} ${f.category} · ${f.severity}${f.required ? " · REQUIRED" : ""}\n` +
              `  Quote: "${f.quote}"\n` +
              `  Recommended change: ${f.recommendedChange}\n` +
              `  Supporting passage: ${f.supportingPassageId ?? "none (unsupported)"}\n` +
              `  Detected by: ${f.detectedBy}`,
          )
          .join("\n\n")
      : "  (no findings)";
  return [
    `CONTENT REVIEW — ${req.contentTitle}`,
    `Partner: ${req.partnerId} (${req.partnerTier})   Type: ${req.contentType}`,
    `Verdict: ${review.verdict}   Score: ${review.score}/5   Required changes: ${review.changesCount}`,
    "",
    "FINDINGS",
    findingBlocks,
    "",
    `Reviewer summary: ${review.summary}`,
    "",
    "(This is an annotated review artifact. It records findings and recommended changes only; it contains no rewritten or generated marketing copy.)",
  ].join("\n");
}

/**
 * Build the two draft-first artifacts a completed review produces (§3.1
 * "Draft-first action"): the partner-facing findings email and the annotated
 * review export. BOTH are PROCESS artifacts — a findings summary + next steps
 * and an annotated findings report — NOT regenerated marketing copy (guardrail
 * #1). BOTH land `status:'pending'`: the only path to `dispatched` is a matching
 * approved `Approval` through the runtime dispatch queue (guardrail #2), never
 * this function.
 */
export function buildReviewDrafts(
  review: ReviewResult,
  req: ReviewRequest,
  opts: BuildDraftsOptions = {},
): { partnerEmail: Draft; reviewExport: Draft } {
  const reviewId = opts.reviewId ?? randomUUID();
  const createdAt = opts.now ?? new Date().toISOString();
  const createdBy = opts.createdBy ?? "reviewer";

  const partnerEmail = Draft.parse({
    id: randomUUID(),
    kind: "partner_email",
    refId: reviewId,
    subject: `Content review — ${req.contentTitle} — ${review.verdict}`,
    body: partnerEmailBody(review, req),
    channel: "email",
    status: "pending",
    createdBy,
    createdAt,
  });

  const reviewExport = Draft.parse({
    id: randomUUID(),
    kind: "review_export",
    refId: reviewId,
    subject: `Annotated review — ${req.contentTitle}`,
    body: reviewExportBody(review, req),
    channel: "export",
    status: "pending",
    createdBy,
    createdAt,
  });

  return { partnerEmail, reviewExport };
}
