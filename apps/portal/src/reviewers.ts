/**
 * reviewers.ts — the `reviewFn` injected into `runContentReview` (@mstack/runtime).
 *
 * Same pattern as `apps/cli/src/reviewers.ts` (this file is not imported cross-app —
 * apps don't depend on each other's internals in this repo, only `packages/*` are
 * shared — so the small, self-contained reviewFn-construction logic is reproduced
 * here rather than imported). Both modes produce a core `ReviewResult` (the
 * reviewer's verdict), then run the SAME assembly (`toReviewFnResult`): mint the
 * persisted `Review` primitive (findings get db ids) and build the two draft-first
 * artifacts via the reviewer's own `buildReviewDrafts`. Only the ReviewResult
 * SOURCE differs:
 *   - offline: `scanDeterministic` (mechanical rule layer, no network, no LLM)
 *   - live:    `reviewAsset` (extract → retrieve[LanceDB] → judge[Opus] → score)
 *
 * GUARDRAIL #1 (reviewer ≠ generator): the `summary` is a reviewer NOTE, every
 * `recommendedChange` is a targeted instruction, and the two drafts are PROCESS
 * artifacts (a findings email + an annotated export) — never regenerated
 * marketing prose. Enforced by the `ReviewResult`/`Draft` schemas themselves.
 */
import { Finding, Review, ReviewResult, newId, nowIso, scoreForChanges } from "@mstack/core";
import type { FindingDraft, Guideline, ReviewRequest, ReviewVerdict } from "@mstack/core";
import type { GuidelineCorpus } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";
import {
  scanDeterministic,
  buildReviewDrafts,
  reviewAsset,
  createLanceCorpus,
  loadGuidelinesJson,
  loadFullGuidelineCorpus,
  HuggingFaceEmbedder,
} from "@mstack/reviewer";
import type { ReviewFn, ReviewFnResult } from "@mstack/runtime";

/**
 * Load the guideline rule rows for the offline pre-scan. Prefers the seeded
 * warehouse (proves the seed→portal data flow); falls back to reading
 * `data/corpus/guidelines.json` directly so the portal works even before a
 * `mstack seed` / self-seed has run. `scanDeterministic` filters by `type`/
 * `category` itself, so passing the full set (incl. approved_messaging rows) is fine.
 */
export async function loadGuidelines(memory: MemoryRepo): Promise<Guideline[]> {
  const seeded = await memory.listGuidelines();
  if (seeded.length > 0) return seeded;
  return loadGuidelinesJson();
}

/** ReviewResult → { review (persisted), partnerEmail, reviewExport }. Shared by
 *  both modes: the runtime's `ReviewFn` contract wants the full `Review`
 *  primitive, while `buildReviewDrafts` wants the `ReviewResult` — build both
 *  off the one result, linking the drafts to the review via `reviewId`. */
function toReviewFnResult(result: ReviewResult, req: ReviewRequest): ReviewFnResult {
  const reviewId = newId("rev");
  const assetId = newId("asset");
  const createdAt = nowIso();

  const findings = result.findings.map((f) => Finding.parse({ ...f, id: newId("find"), reviewId }));

  const review = Review.parse({
    id: reviewId,
    assetId,
    partnerId: req.partnerId,
    partnerTier: req.partnerTier,
    score: result.score,
    changesCount: result.changesCount,
    verdict: result.verdict,
    findings,
    exportRefs: {},
    status: "open",
    createdAt,
  });

  const { partnerEmail, reviewExport } = buildReviewDrafts(result, req, { reviewId, now: createdAt });
  return { review, partnerEmail, reviewExport };
}

/** A reviewer NOTE (not marketing copy) summarizing the offline pre-scan. */
function offlineSummary(req: ReviewRequest, verdict: ReviewVerdict, changesCount: number, findings: FindingDraft[]): string {
  const categories = [...new Set(findings.map((f) => f.category))];
  const catStr = categories.length > 0 ? categories.join(", ") : "none";
  return (
    `Deterministic pre-scan of "${req.contentTitle}" (${req.contentType}) flagged ${findings.length} finding(s), ` +
    `${changesCount} required — categories: ${catStr}. Verdict ${verdict} by the rubric (score ${scoreForChanges(changesCount)}/5). ` +
    `Offline mode: mechanical rule layer only; set ANTHROPIC_API_KEY to add the Claude extract→retrieve→judge pass. ` +
    `This note is a review record, not marketing copy.`
  );
}

/**
 * OFFLINE ReviewResult — `scanDeterministic` → verdict/score/findings:
 * `changesCount` = required-finding count, `score` = `scoreForChanges(...)`,
 * verdict RETURNED iff changesCount > 0 else APPROVED. No network, no LLM.
 */
export function offlineReviewResult(req: ReviewRequest, guidelines: Guideline[]): ReviewResult {
  const findings = scanDeterministic({ content: req.content, partnerTier: req.partnerTier }, guidelines);
  const changesCount = findings.filter((f) => f.required).length;
  const score = scoreForChanges(changesCount);
  const verdict: ReviewVerdict = changesCount > 0 ? "RETURNED" : "APPROVED";
  return ReviewResult.parse({
    score,
    changesCount,
    verdict,
    findings,
    summary: offlineSummary(req, verdict, changesCount, findings),
  });
}

/** OFFLINE reviewFn — wraps `offlineReviewResult` into the runtime's contract. */
export function offlineReviewFn(guidelines: Guideline[]): ReviewFn {
  return async (req) => toReviewFnResult(offlineReviewResult(req, guidelines), req);
}

/** LIVE reviewFn — the full Claude pipeline (`reviewAsset`) → same assembly. */
export function liveReviewFn(corpus: GuidelineCorpus): ReviewFn {
  return async (req) => {
    const result = await reviewAsset(req, { corpus });
    return toReviewFnResult(result, req);
  };
}

/**
 * Build the live reviewer corpus: a LanceDB-backed `GuidelineCorpus` with the
 * real `HuggingFaceEmbedder`, ingesting the full corpus (guidelines.json rows +
 * approved-messaging.md chunks) so both `rules()` and `retrieve()` are populated
 * in-process. Only used in live mode.
 */
export async function buildLiveCorpus(lanceDir: string): Promise<GuidelineCorpus> {
  const corpus = createLanceCorpus({ dbPath: lanceDir, embedder: new HuggingFaceEmbedder() });
  await corpus.ingest(await loadFullGuidelineCorpus());
  return corpus;
}
