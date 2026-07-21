/**
 * dashboard.ts — portal-level display metadata for the Review Dashboard.
 *
 * The persisted `Review` primitive (`@mstack/core`) does not carry the
 * submitted `contentTitle`/`contentType` — by design, `Review` is the
 * REVIEWER'S verdict (score/verdict/findings), not a copy of the submission.
 * The title only exists in the `ReviewRequest` the Submit-tab form posts and
 * in the free-text prose of the two generated `Draft` bodies (see
 * `@mstack/reviewer`'s `reviewExportBody`/`partnerEmailBody`), so this module
 * caches the two display-only fields in-process, keyed by review id, the
 * moment a review is created. Every `Review` this app can ever list was
 * created by ITS OWN `POST /api/review` handler (there is no other write
 * path), so the cache is always populated for a review created in the
 * current process.
 *
 * KNOWN, DOCUMENTED LIMITATION: a server restart loses this cache for
 * reviews created in a PRIOR process — the review's score/verdict/findings
 * themselves are unaffected (DuckDB via @mstack/memory is the system of
 * record for those); only the two display-only fields fall back to a
 * placeholder string below. Fixing this durably would mean either extending
 * `@mstack/core`'s `Review` schema or adding a side-table to `@mstack/memory`
 * — out of scope for this app, which only consumes those packages.
 */
export interface ReviewMeta {
  contentTitle: string;
  contentType: string;
}

const cache = new Map<string, ReviewMeta>();

export function rememberReviewMeta(reviewId: string, meta: ReviewMeta): void {
  cache.set(reviewId, meta);
}

const FALLBACK_META: ReviewMeta = {
  contentTitle: "(title unavailable — server restarted since submission)",
  contentType: "other",
};

export function getReviewMeta(reviewId: string): ReviewMeta {
  return cache.get(reviewId) ?? FALLBACK_META;
}
