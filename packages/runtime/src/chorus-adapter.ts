/**
 * chorus-adapter.ts — a NOTE (not a live integration) on how the functions in this package
 * register as steps on chorus (https://github.com/LamaSu/federated-workflow-runtime), the
 * self-hosted workflow runtime that owns triggers/retries/self-healing
 * (research/06-architecture.md §2, §3.3, §4). `chorus/` itself is a top-level directory of
 * workflow-definition files in THIS repo (`marketing-agents-stack/chorus/`), scaffolded as a
 * separate build task — it is not a dependency of `packages/runtime`, and this file does not
 * import it. What this package exports is the STEP LOGIC; chorus is the ENGINE that calls it
 * with retries/scheduling/self-heal around it.
 *
 * `ChorusStepFn` below is a minimal, illustrative shape (input in, result out, async) — it is
 * NOT chorus's actual step-registration API, which this package has no dependency on and
 * therefore cannot type against. It exists so the mapping from "function in this package" to
 * "chorus step" is concrete enough to read, not just asserted in prose.
 *
 * ── content-review workflow (§4.1) ──────────────────────────────────────────────────────
 *   trigger:  chorus webhook `POST /workflows/content-review` (portal "Submit for review")
 *             | manual (cli)
 *   steps 1-5 (ingest/pre_scan/review/persist_review/draft) ARE `runContentReview` — chorus
 *             retries this step automatically on failure (idempotent: re-running it before a
 *             human has acted just re-derives the same pending drafts).
 *   step  6   (HITL_APPROVAL) is NOT a chorus step in the usual sense — chorus's registration
 *             blocks on it indefinitely (human-owned): the portal UI calls `DraftStore#approve`
 *             / `#reject` directly, outside chorus's retry loop.
 *   step  7   (on_approve -> dispatch -> Outcome) IS `approveAndDispatch` — safe to retry (a
 *             second attempt that starts from `DraftStore#approve` on an already-`dispatched`
 *             draft is refused there (it never re-flips the status back to `'approved'`), and
 *             `dispatchDraft`'s own check independently requires exactly `status:'approved'`
 *             too — so a chorus retry after a partial failure cannot double-send).
 *
 * ── account-activation workflow (§4.2) ──────────────────────────────────────────────────
 *   trigger:  chorus cron (weekly) | signal-threshold webhook | manual (cli)
 *   steps 1-6 (pull_signals/unify/score/swarm/persist_dec/draft) ARE `runAccountActivation`
 *             (its injected `activateFn` is where pull/unify/score/swarm actually happen —
 *             see the file header on `workflows/account-activation.ts` for the wiring wrinkle
 *             around `@mstack/account-intel`'s self-persisting `activateAccount`).
 *   step  7   (HITL_APPROVAL, copilot) is the same human-owned `DraftStore#approve`/`#reject`
 *             path as above; the autopilot variant (auto-approve, low-tier only, NEVER
 *             STRONG_FIT/VIP — §8 guardrail #2) is a POLICY DECISION about whether to call
 *             `approveAndDispatch` programmatically instead of waiting on a human. That policy
 *             itself is out of this package's scope (see `@mstack/account-intel`'s
 *             `policy.ts#isAutopilotEligible`) — this package only ever dispatches through the
 *             one gated function, autopilot or not.
 *   step  8   (on_approve -> dispatch -> Outcome) IS `approveAndDispatch`, same idempotency
 *             note as above.
 *
 * Both workflows' retries: the pre-approval steps (1-5 / 1-6) auto-retry under chorus because
 * they are pure derivations from `memory` + the injected agent function; step 6/7
 * (HITL_APPROVAL) blocks indefinitely and is never retried by chorus itself — it waits on a
 * human; the final dispatch step is retried-but-idempotent as noted above.
 */

/** Illustrative only — see file header. Not chorus's real step-registration type. */
export interface ChorusStepFn<TIn, TOut> {
  (input: TIn): Promise<TOut>;
}

/**
 * Illustrative wiring sketch for a `chorus/content-review.ts` workflow file (NOT executed by
 * this package — chorus calls the underlying functions itself once such a file exists):
 *
 * ```ts
 * import { runContentReview, approveAndDispatch, DraftStore } from "@mstack/runtime";
 * import { openMemory } from "@mstack/memory";
 * import { reviewAsset, buildReviewDrafts } from "@mstack/reviewer";
 *
 * const memory = await openMemory();
 * const draftStore = new DraftStore(memory);
 *
 * // registered as the chorus step for "review" (steps 1-5, §4.1):
 * const reviewStep: ChorusStepFn<ReviewRequest, ContentReviewResult> = (req) =>
 *   runContentReview(req, {
 *     memory,
 *     draftStore,
 *     reviewFn: async (r) => {
 *       const review = await reviewAsset(r, { corpus });
 *       const { partnerEmail, reviewExport } = buildReviewDrafts(review, r);
 *       return { review, partnerEmail, reviewExport };
 *     },
 *   });
 *
 * // called by the portal UI on human approval, OUTSIDE chorus's retry loop (step 6-7, §4.1):
 * const approveStep: ChorusStepFn<{ draftId: string; actor: string }, Outcome> = ({ draftId, actor }) =>
 *   approveAndDispatch(draftId, actor, new LocalOutreachChannel(), { memory, draftStore });
 * ```
 */
export const CHORUS_ADAPTER_NOTE =
  "See this file's header comment for the content-review / account-activation step mapping. " +
  "This export exists only so the note is reachable from the package's public surface " +
  "(e.g. for a future `mstack` CLI help command) — it carries no runtime behavior.";
