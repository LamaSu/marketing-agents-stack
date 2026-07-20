/**
 * @mstack/reviewer — rules.ts — the deterministic pre-scan.
 *
 * Wave-2 scope (research/06-architecture.md §7 W2-T4). Given an asset's text
 * + partnerTier plus the corpus's `Guideline` rows, produces candidate
 * `FindingDraft[]` for the MECHANICAL claim categories — the ones that should
 * never depend on model mood (research/06-architecture.md §3.1 pipeline step
 * 2; research/tools/C-claim-verification.md "a deterministic rule layer").
 *
 * DESIGN PRINCIPLE: wherever a `Guideline` row's `content` prose contains
 * literal quoted terms — lexicon/denylist rows in this corpus consistently do
 * ("Never use 'guarantee', 'guaranteed', ...") — this module EXTRACTS those
 * terms from the guideline DATA and matches them; it does not hardcode the
 * fixture's specific banned words. Two categories genuinely resist pure
 * literal-term extraction, because the corpus's own planted violations
 * paraphrase the guideline's example phrasing rather than quote it verbatim
 * (a partner asset says "no other platform ON THE MARKET comes close", not
 * the guideline's literal "no other platform comes close"; another says
 * "will be launching ... in Q4 2026", a date, not a literal string the
 * guideline could quote). For those two —`unapproved_superlative`'s
 * comparative construction and `roadmap_disclosure`'s forward-looking-date
 * pattern — this module adds one small, clearly-labeled STRUCTURAL regex on
 * top of the data-driven extraction. `badge_tier_misuse` is likewise a small
 * structural table cross-referenced to the corpus's tier_map guideline ids: a
 * badge-eligibility rule is a hard lookup, not free text to parse. Every such
 * judgment call is commented at its call site below.
 *
 * TODO(wave3): `scanDeterministic()`'s output is a set of HIGH-CONFIDENCE
 * PRIORS, not a final findings list. packages/agents' judge step (Claude/
 * Opus) merges these in per research/06-architecture.md §3.1 step 5
 * ("Deterministic findings from step 2 are merged in as high-confidence
 * priors"). `uncited_quantitative` in particular is a citation-window
 * HEURISTIC (see `scanUncitedQuantitative`) and is the best category for the
 * Claude judge to double-check or override; the Claude judge is also what
 * catches everything this file structurally cannot (novel phrasing, implied
 * claims, tone).
 *
 * Every emitted `FindingDraft` has `detectedBy: "deterministic"` and
 * `supportingPassageId: null` — this layer never retrieves; that's
 * `LanceCorpus.retrieve()` (lance-corpus.ts), called downstream in the judge
 * step to find supporting evidence for claims this layer does NOT flag.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ClaimCategory, FindingDraft } from "@mstack/core";
import type { Guideline, PartnerTier } from "@mstack/core";

/* ─────────────────────────── small shared helpers ─────────────────────────── */

/** `noUncheckedIndexedAccess` types every `RegExpExecArray` bracket access as
 *  possibly-undefined (it can't know index 0 of a successful match is always
 *  present) — this centralizes the `?? ""` fallback in one place. */
function group(m: RegExpExecArray, i: number): string {
  return m[i] ?? "";
}

/** A lexicon/denylist row states its BANNED terms first, then frequently
 *  shows the APPROVED phrasing to use *instead* — and that model answer is
 *  quoted too: gl-lex-superlative-1 ends "...Describe what the solution does
 *  concretely instead (e.g. 'automates document-heavy workflows across
 *  finance, legal, and operations')"; gl-lex-guarantee-1 says 'phrase it as
 *  "customers have reported..."'. Those quoted phrases are the OPPOSITE of a
 *  violation, so pulling EVERY quote turns the guideline's own recommended
 *  wording into a banned term — and then flags the CLEAN asset that correctly
 *  follows the guidance (the fully-cited Northland case study uses that exact
 *  'automates document-heavy workflows across finance, legal, and operations'
 *  phrasing the superlative rule RECOMMENDS). `prohibitionClause` restricts
 *  extraction to the content up to the first positive-guidance cue; rows with
 *  no such cue (gl-lex-guarantee-2, gl-lex-superlative-2, every denylist row)
 *  are returned whole, so no real banned term is lost. */
const POSITIVE_GUIDANCE_CUE = /\binstead\b|\be\.g\.|\bphrase it as\b|\brephrase\b|\breword\b/i;

function prohibitionClause(content: string): string {
  const m = POSITIVE_GUIDANCE_CUE.exec(content);
  return m ? content.slice(0, m.index) : content;
}

/** Extracts single- or double-quoted BANNED terms from a guideline row's
 *  prohibition clause, e.g. "Never use 'guarantee', 'guaranteed'..." ->
 *  ["guarantee", "guaranteed"]. Handles the corpus's mixed quoting (double
 *  quotes are used for terms that themselves contain an apostrophe, e.g.
 *  "world's best"). Positive "do this instead" example phrasings are NOT
 *  banned terms and are excluded — see `prohibitionClause`. */
function extractQuotedTerms(content: string): string[] {
  const terms: string[] = [];
  const re = /'([^']+)'|"([^"]+)"/g;
  let m: RegExpExecArray | null;
  const clause = prohibitionClause(content);
  while ((m = re.exec(clause)) !== null) {
    const term = group(m, 1) || group(m, 2);
    if (term) terms.push(term);
  }
  return terms;
}

/** A lexicon row is "citation-conditional" if its own prose says the term is
 *  fine WITH a citation (gl-lex-superlative-2, gl-lex-quant-1) rather than
 *  banned outright (gl-lex-guarantee-1/2, gl-lex-superlative-1). */
function isCitationConditional(content: string): boolean {
  return /\bcited\b|\bcitation\b|\bpublished source\b/i.test(content);
}

// Deliberately does NOT include a bare "internal review"-style marker: per
// gl-lex-quant-1's own text, an internal reference without an attached URL
// or written KLZ approval is not a valid citation, so treating "internal ...
// review" alone as citing evidence would be MORE lenient than the guideline
// itself -- every marker here is a real citation signal (a URL, a named
// domain, or an explicit sourcing phrase).
const CITATION_MARKER = /https?:\/\/|\b[a-z0-9-]+\.(com|io|net|org)\/|published at|according to|\bsource:|reported at|benchmark/i;

/** Does a citation-looking marker appear within `window` chars either side of
 *  [start, end) in `text`? Used for citation-conditional lexicon terms and
 *  the uncited-quantitative numeric scan. Deliberately generous (250 chars —
 *  this corpus's citations sometimes precede the number by a full clause,
 *  e.g. "(published at ...), teams ... reported a median 22%") because a
 *  false "cited" suppression is cheaper here than a false positive the
 *  Wave-3 judge then has to waste a turn dismissing. */
function hasCitationNearby(text: string, start: number, end: number, window = 250): boolean {
  const from = Math.max(0, start - window);
  const to = Math.min(text.length, end + window);
  return CITATION_MARKER.test(text.slice(from, to));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive match on `term` allowing a simple trailing inflection
 *  (guarantee -> guarantees/guaranteed/guaranteeing) so a literal lexicon
 *  term still catches the verb form a partner actually writes. Fresh
 *  `RegExp` per call (global-flag regexes carry `lastIndex` state that must
 *  not leak between scans).
 *
 *  The leading `\b` is only added when `term` itself starts with a word
 *  character. `\b` asserts a transition between a word and non-word
 *  character -- for a term like "#1" (gl-lex-superlative-1), the character
 *  immediately before it in real text is typically also non-word (a space),
 *  so a leading `\b` would never find a boundary there and the term would
 *  silently never match. */
function termRegex(term: string): RegExp {
  const leadingBoundary = /^\w/.test(term) ? "\\b" : "";
  return new RegExp(`${leadingBoundary}${escapeRegExp(term)}\\w*`, "gi");
}

function toClaimCategory(raw: string): ClaimCategory | null {
  const parsed = ClaimCategory.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function severityOf(guideline: Guideline | undefined, fallback: FindingDraft["severity"] = "medium"): FindingDraft["severity"] {
  return guideline?.severity ?? fallback;
}

/** Builds + validates a `FindingDraft` (round-tripping through the real zod
 *  schema catches a shape bug here instead of at the caller). */
function draft(input: {
  category: ClaimCategory;
  quote: string;
  span?: { start: number; end: number };
  recommendedChange: string;
  severity: FindingDraft["severity"];
  required?: boolean;
}): FindingDraft {
  return FindingDraft.parse({
    category: input.category,
    required: input.required ?? input.severity !== "low",
    quote: input.quote,
    span: input.span,
    recommendedChange: input.recommendedChange,
    supportingPassageId: null,
    detectedBy: "deterministic",
    severity: input.severity,
  });
}

/* ─────────────────────── 1. lexicon terms (data-driven) ─────────────────────── */
/* Covers guaranteed_outcome (unconditional) and the unconditional half of
 * unapproved_superlative (best-in-class/unmatched/unrivaled/#1/world's best),
 * driven entirely by the corpus's `type: "lexicon"` rows' quoted terms. */

function scanLexiconTerms(text: string, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const lexiconRows = guidelines.filter((g) => g.type === "lexicon");

  for (const row of lexiconRows) {
    const category = toClaimCategory(row.category);
    if (!category) continue; // category isn't one of the 6 ClaimCategory values -- not scannable here
    const terms = extractQuotedTerms(row.content);
    if (terms.length === 0) continue; // pattern-shaped rules (uncited_quantitative) are scanned separately
    const conditional = isCitationConditional(row.content);

    for (const term of terms) {
      const re = termRegex(term);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const matched = group(m, 0);
        const start = m.index;
        const end = start + matched.length;
        if (conditional && hasCitationNearby(text, start, end)) continue;
        findings.push(
          draft({
            category,
            quote: matched,
            span: { start, end },
            recommendedChange:
              category === "guaranteed_outcome"
                ? `Remove the certainty/guarantee language ("${matched}"); rephrase as a cited customer-reported result or remove the claim.`
                : `Remove the unqualified superlative ("${matched}"), or add the third-party citation the guideline requires; otherwise describe the capability concretely.`,
            severity: severityOf(row),
          }),
        );
      }
    }
  }
  return findings;
}

/* ─────────────── 2. comparative superlative (structural heuristic) ─────────── */
/* "no other platform/partner/solution/vendor ..." -- the corpus's planted
 * violations paraphrase the guideline's literal example phrase ("no other
 * platform ON THE MARKET comes close", "no other partner HAS GONE AS DEEP"),
 * so literal-term extraction alone would miss both. This is one of two places
 * in this module that isn't pure data-driven extraction (see file header). */

function scanComparativeSuperlative(text: string, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const re = /\bno other (platform|partner|solution|vendor)s?\b[^.!?\n]{0,80}/gi;
  const sourceRow = guidelines.find((g) => g.type === "lexicon" && g.category === "unapproved_superlative");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = group(m, 0).trim();
    const start = m.index;
    const end = start + matched.length;
    findings.push(
      draft({
        category: "unapproved_superlative",
        quote: matched,
        span: { start, end },
        recommendedChange: "Remove the unqualified comparative claim; describe the capability concretely instead.",
        severity: severityOf(sourceRow),
      }),
    );
  }
  return findings;
}

/* ─────────────────── 3. uncited quantitative (pattern + citation) ──────────── */
/* gl-lex-quant-1's content is itself a pattern-shaped instruction ("Flag any
 * percent / multiplier / dollar-amount pattern that has no adjacent
 * citation"), not a literal term list -- so this scanner matches the NUMERIC
 * SHAPE directly rather than extracting quoted terms. */

const NUMERIC_CLAIM = /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\$\s?\d+(?:,\d{3})*(?:\.\d+)?/gi;

function scanUncitedQuantitative(text: string, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const sourceRow = guidelines.find((g) => g.category === "uncited_quantitative");
  const re = new RegExp(NUMERIC_CLAIM); // fresh instance -> lastIndex starts at 0
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = group(m, 0);
    const start = m.index;
    const end = start + matched.length;
    if (hasCitationNearby(text, start, end)) continue;
    findings.push(
      draft({
        category: "uncited_quantitative",
        quote: matched,
        span: { start, end },
        recommendedChange: `Cite a published source for this figure ("${matched}"), or remove it.`,
        severity: severityOf(sourceRow),
      }),
    );
  }
  return findings;
}

/* ────────────────────── 4. denylist terms (data-driven) ────────────────────── */

function scanDenylistTerms(text: string, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const denyRows = guidelines.filter((g) => g.type === "denylist");

  for (const row of denyRows) {
    // This corpus's denylist rows are all roadmap_disclosure; fall back to it
    // rather than dropping the row if a future corpus leaves category free-form.
    const category = toClaimCategory(row.category) ?? "roadmap_disclosure";
    const terms = extractQuotedTerms(row.content);
    for (const term of terms) {
      // Placeholder-shaped example terms (e.g. "launching in Q_ 20__") contain
      // characters real text can never contain -- they simply won't match,
      // which is correct: the forward-looking-date scan below covers that
      // rule's actual intent with a real pattern instead of a literal quote.
      const re = termRegex(term);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const matched = group(m, 0);
        const start = m.index;
        const end = start + matched.length;
        findings.push(
          draft({
            category,
            quote: matched,
            span: { start, end },
            recommendedChange: `Remove this reference to an unannounced product, codename, or roadmap item ("${matched}").`,
            severity: severityOf(row),
          }),
        );
      }
    }
  }
  return findings;
}

/* ─────────────── 5. forward-looking dates (structural heuristic) ───────────── */
/* A quarter+year alone isn't a violation -- Northland's "internal Q1 2026
 * operations review" is retrospective, not a leak. Only flag when a
 * forward-looking trigger word sits close by ("will be launching", "coming
 * soon", "upcoming", "planned", "roadmap"). This is the other of the two
 * structural (non-literal-extraction) scanners -- see file header. Recall is
 * not solely dependent on this scanner catching every date: the literal
 * "Agent Marketplace" denylist term (scanDenylistTerms) independently flags
 * roadmap_disclosure on the same ABC Corp sentence, so being conservative
 * here (favoring precision, e.g. not flagging Northland) doesn't cost
 * recall on the category as a whole. */

const FORWARD_LOOKING_TRIGGER = /\b(will be |is |are )?launch(ing|es|ed)?\b|\bcoming soon\b|\bupcoming\b|\bplanned\b|\broadmap\b/i;

function scanForwardLookingDates(text: string, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const sourceRow = guidelines.find((g) => g.type === "denylist" && /forward-looking date/i.test(g.content));
  const re = /\bQ[1-4]\s+20\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = group(m, 0);
    const start = m.index;
    const end = start + matched.length;
    const windowStart = Math.max(0, start - 60);
    if (!FORWARD_LOOKING_TRIGGER.test(text.slice(windowStart, end))) continue;
    findings.push(
      draft({
        category: "roadmap_disclosure",
        quote: matched,
        span: { start, end },
        recommendedChange: `Remove this forward-looking launch date ("${matched}") unless it has a public KLZ announcement to cite.`,
        severity: severityOf(sourceRow, "medium"),
      }),
    );
  }
  return findings;
}

/* ─────────────────── 6. spokesperson allowlist (data-driven) ───────────────── */

/** "Dana Whitfield (VP Partnerships)" -> "Dana Whitfield". Pulls approved
 *  names out of the allowlist guideline prose rather than hardcoding them. */
function extractApprovedNames(guidelines: Guideline[]): Set<string> {
  const names = new Set<string>();
  const rows = guidelines.filter((g) => g.type === "allowlist" && g.category === "unapproved_spokesperson_quote");
  const re = /\b([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)\s*[,(]/g;
  for (const row of rows) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(row.content)) !== null) {
      const name = group(m, 1).trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Finds `"...quote...," said NAME[, TITLE][, at KLZ]` and the reversed
 * `NAME, TITLE, ... said "...quote..."` / `— NAME, TITLE, KLZ` attribution
 * styles, returning each attributed name with the quote's span. A
 * best-effort heuristic, not a full NLP parse -- the mechanical categories
 * this module targets are all like this by design (research/tools/
 * C-claim-verification.md's "deterministic rule layer" is explicitly the
 * cheap/precise half of the pipeline; novel attribution phrasing is exactly
 * what the Wave-3 Claude judge is for).
 */
function findQuoteAttributions(text: string): Array<{ name: string; quoteStart: number; quoteEnd: number }> {
  const results: Array<{ name: string; quoteStart: number; quoteEnd: number }> = [];
  const quoteRe = /["“]([^"“”]{15,})["”]/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(text)) !== null) {
    const quoteStart = m.index;
    const quoteEnd = quoteStart + group(m, 0).length;
    const after = text.slice(quoteEnd, quoteEnd + 100);
    const before = text.slice(Math.max(0, quoteStart - 100), quoteStart);

    const saidAfter = /^[,.]?\s*said\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3})/.exec(after);
    const saidBefore = /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3}),[^"“]{0,60}said:?\s*$/.exec(before);
    const dashBefore = /[—-]\s*([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3}),/.exec(before);

    const rawName = (saidAfter && group(saidAfter, 1)) || (saidBefore && group(saidBefore, 1)) || (dashBefore && group(dashBefore, 1));
    if (rawName) {
      results.push({ name: rawName.trim(), quoteStart, quoteEnd });
    }
  }
  return results;
}

function scanSpokespersonAllowlist(text: string, guidelines: Guideline[]): FindingDraft[] {
  const approved = extractApprovedNames(guidelines);
  if (approved.size === 0) return []; // no allowlist in this corpus -> nothing to check against
  const sourceRow = guidelines.find((g) => g.type === "allowlist" && g.category === "unapproved_spokesperson_quote");
  const findings: FindingDraft[] = [];

  for (const { name, quoteStart, quoteEnd } of findQuoteAttributions(text)) {
    if (approved.has(name)) continue;
    findings.push(
      draft({
        category: "unapproved_spokesperson_quote",
        quote: text.slice(quoteStart, quoteEnd),
        span: { start: quoteStart, end: quoteEnd },
        recommendedChange: `Remove this quote attributed to ${name}, or obtain written, piece-specific approval from KLZ Partner Marketing; only ${[...approved].join(" and ")} are pre-approved spokespeople.`,
        severity: severityOf(sourceRow),
      }),
    );
  }
  return findings;
}

/* ──────────────────── 7. badge / tier misuse (structural table) ────────────── */
/* Data-driven prose parsing is too fragile for a hard eligibility rule -- this
 * table is the code-level encoding of the corpus's tier_map rows
 * (gl-tier-badge-1, gl-tier-badge-2 in data/corpus/guidelines.json): "'Powered
 * by KLZ Orchestrate' badge is Elite-tier only. Select-tier partners must use
 * ... 'KLZ Select Partner' ... Registered-tier partners may not display any
 * KLZ badge." If the corpus's tier_map content changes, this table needs a
 * matching update -- `rules()` (lance-corpus.ts) still exposes the raw
 * tier_map rows to the Wave-3 Claude judge for anything this table misses. */
const BADGE_TIER_RULES: ReadonlyArray<{ badge: string; requiredTier: PartnerTier }> = [
  { badge: "Powered by KLZ Orchestrate", requiredTier: "Elite" },
  { badge: "KLZ Select Partner", requiredTier: "Select" },
];

function scanBadgeTier(text: string, partnerTier: PartnerTier, guidelines: Guideline[]): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const sourceRow = guidelines.find((g) => g.type === "tier_map");
  for (const rule of BADGE_TIER_RULES) {
    const idx = text.indexOf(rule.badge);
    if (idx === -1) continue;
    if (partnerTier === rule.requiredTier) continue;
    findings.push(
      draft({
        category: "badge_tier_misuse",
        quote: rule.badge,
        span: { start: idx, end: idx + rule.badge.length },
        recommendedChange: `This partner is "${partnerTier}" tier; "${rule.badge}" is ${rule.requiredTier}-only. Use the badge/designation matching this partner's actual tier (or no badge, for Registered).`,
        severity: severityOf(sourceRow),
      }),
    );
  }
  return findings;
}

/* ───────────────────── 8. inline secret pass (always-on) ───────────────────── */
/* A small, dependency-free regex backstop for the "gitleaks pass for secret
 * leakage" research/06-architecture.md §3.1 step 2 calls for. `ClaimCategory`
 * has no dedicated secret-leak value (the schema's six values are all
 * marketing-claim categories) -- a leaked credential is mapped onto
 * `roadmap_disclosure` (the closest existing category: undisclosed internal
 * information) with a quote/recommendedChange that names exactly what fired,
 * so nothing is silently mislabeled. See `runGitleaksIfAvailable` below for
 * the real, OPT-IN `gitleaks` CLI backstop research/tools/
 * C-claim-verification.md recommends ("ADOPT gitleaks ... as the secret
 * backstop") -- this inline pass is the always-on fallback the task calls
 * for; gitleaks itself is not wired into `scanDeterministic` by default. */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "generic API key/secret assignment", re: /\b(api[_-]?key|secret|token)\b\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/gi },
  { label: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { label: "private key block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
];

function scanInlineSecrets(text: string): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const { label, re } of SECRET_PATTERNS) {
    const pattern = new RegExp(re); // fresh lastIndex per call
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const matched = group(m, 0);
      const start = m.index;
      const end = start + matched.length;
      findings.push(
        draft({
          category: "roadmap_disclosure",
          quote: matched,
          span: { start, end },
          recommendedChange: `Remove this credential-shaped string before publishing (${label}); rotate the credential if it is real.`,
          severity: "high",
        }),
      );
    }
  }
  return findings;
}

/* ───────────────────────────── orchestrator ─────────────────────────────── */

/** Same category firing on the exact same quoted text more than once
 *  (e.g. "Agent Marketplace" is denylisted by two separate guideline rows)
 *  collapses to one finding. Different quotes in the same category (e.g.
 *  "Agent Marketplace" and "Q4 2026", both roadmap_disclosure) stay separate
 *  -- they're distinct textual violations. */
function dedupe(findings: FindingDraft[]): FindingDraft[] {
  const seen = new Set<string>();
  const out: FindingDraft[] = [];
  for (const f of findings) {
    const key = `${f.category} ${f.quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * The deterministic pre-scan (research/06-architecture.md §3.1 pipeline step
 * 2). Runs every mechanical check against `asset.content` using the supplied
 * `Guideline[]` (typically `corpus.rules()`, but any Guideline[] works --
 * each scanner filters by `type`/`category` itself and degrades gracefully,
 * returning no findings for a category, if the corpus has no matching row).
 * Offline, synchronous, no network, no filesystem access.
 */
export function scanDeterministic(asset: { content: string; partnerTier: PartnerTier }, guidelines: Guideline[]): FindingDraft[] {
  const { content, partnerTier } = asset;
  const findings = [
    ...scanLexiconTerms(content, guidelines),
    ...scanComparativeSuperlative(content, guidelines),
    ...scanUncitedQuantitative(content, guidelines),
    ...scanDenylistTerms(content, guidelines),
    ...scanForwardLookingDates(content, guidelines),
    ...scanSpokespersonAllowlist(content, guidelines),
    ...scanBadgeTier(content, partnerTier, guidelines),
    ...scanInlineSecrets(content),
  ];
  return dedupe(findings);
}

/* ──────────────── optional opt-in backstop: real gitleaks CLI ──────────────── */

interface GitleaksFinding {
  Description?: string;
  Match?: string;
  RuleID?: string;
}

/**
 * Best-effort, OPT-IN secret scan via the real `gitleaks` CLI (research/
 * tools/C-claim-verification.md: "ADOPT gitleaks ... as the secret
 * backstop"). NOT called by `scanDeterministic` — callers invoke this
 * explicitly when they want the stronger (entropy + 150+ rule) backstop on
 * top of the always-on inline regex pass above. Gracefully returns `[]`
 * (never throws) if the `gitleaks` binary isn't installed or produces
 * nothing parseable, so it's safe to call unconditionally in an environment
 * that may or may not have it (the same graceful-degradation discipline
 * `vet-scanner` uses for its own external scanners). This package's tests
 * never invoke it (see README) — it shells out, which is out of scope for an
 * offline unit test.
 */
export async function runGitleaksIfAvailable(targetPath: string): Promise<FindingDraft[]> {
  const run = promisify(execFile);
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "mstack-gitleaks-"));
    const reportPath = join(dir, "report.json");
    await run("gitleaks", [
      "detect",
      "--source",
      targetPath,
      "--no-git",
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      "--exit-code",
      "0",
    ]);
    const raw = await readFile(reportPath, "utf8");
    const hits = JSON.parse(raw) as GitleaksFinding[];
    return hits.map((f) =>
      draft({
        category: "roadmap_disclosure",
        quote: f.Match ?? f.RuleID ?? "gitleaks finding",
        recommendedChange: `gitleaks flagged a potential secret (${f.RuleID ?? "unknown rule"}${f.Description ? ": " + f.Description : ""}); remove it before publishing.`,
        severity: "high",
      }),
    );
  } catch {
    return []; // gitleaks not installed / not on PATH / nothing parseable -- opt-in, never fatal
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
