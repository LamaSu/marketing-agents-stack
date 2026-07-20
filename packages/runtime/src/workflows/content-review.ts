/**
 * workflows/content-review.ts — the `content-review` chorus workflow
 * (research/06-architecture.md §4.1), minus the two steps that are explicitly out of this
 * package's scope: the reviewer agent pipeline itself (injected as `reviewFn`) and the
 * HITL-approval + dispatch step (`approve-and-dispatch.ts`, invoked separately once a human
 * decides).
 *
 * `reviewFn` is INJECTED so this file stays agnostic to which reviewer implementation runs:
 * live wiring passes an adapter around `@mstack/reviewer`'s `reviewAsset` +
 * `buildReviewDrafts` (see `chorus-adapter.ts`); offline/tests pass a deterministic fake.
 * `packages/runtime` intentionally does not depend on `@mstack/reviewer` — see
 * `chorus-adapter.ts` for why, and for the one wiring wrinkle worth knowing about.
 *
 * Steps: `reviewFn(req)` -> `memory.putReview(review)` -> `draftStore.save(partnerEmail)` +
 * `draftStore.save(reviewExport)` (both land `status:'pending'`) -> return. This function
 * never imports a channel and never calls `dispatchDraft` — the review is a decision, not a
 * send; guardrail #2 lives downstream of here. Guardrail #3 ("writes to memory at least
 * twice"): `putReview` plus the two `draftStore.save` calls (each itself a `memory.putDraft`)
 * total three writes.
 */
import { ReviewRequest } from "@mstack/core";
import type { Draft, Review } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import type { DraftStore } from "../draft-store.js";

export interface ReviewFnResult {
  review: Review;
  partnerEmail: Draft;
  reviewExport: Draft;
}

/** The injected reviewer pipeline. Live = an adapter around `@mstack/reviewer`; offline/tests
 *  = any deterministic function returning the same shape. `runContentReview` is agnostic to
 *  which. */
export type ReviewFn = (req: ReviewRequest) => Promise<ReviewFnResult>;

export interface ContentReviewDeps {
  reviewFn: ReviewFn;
  memory: MemoryRepo;
  draftStore: DraftStore;
}

export interface ContentReviewResult {
  review: Review;
  drafts: { partnerEmail: Draft; reviewExport: Draft };
}

/**
 * Run the content-review workflow up to (not including) human approval. Persists the `Review`
 * and lands both drafts `pending`. Dispatches nothing.
 */
export async function runContentReview(
  req: ReviewRequest,
  deps: ContentReviewDeps,
): Promise<ContentReviewResult> {
  const request = ReviewRequest.parse(req);

  const { review, partnerEmail, reviewExport } = await deps.reviewFn(request);

  await deps.memory.putReview(review);

  const savedPartnerEmail = await deps.draftStore.save(partnerEmail);
  const savedReviewExport = await deps.draftStore.save(reviewExport);

  return {
    review,
    drafts: { partnerEmail: savedPartnerEmail, reviewExport: savedReviewExport },
  };
}
