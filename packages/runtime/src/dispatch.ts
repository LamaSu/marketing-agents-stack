/**
 * dispatch.ts — the only send path in this repo IN THE NORMAL FLOW (research/06-architecture.md
 * §3.3, §8 guardrail #2; docs/build-conventions.md guardrail #2). "Only" is grep-guarded, not a
 * sandbox: `dispatch.test.ts` asserts this package's production source has exactly one
 * `OutreachChannel.dispatch` call site — this one — so no ACCIDENTAL second send path can slip in.
 * It is NOT proof against a malicious in-process caller that imports a channel directly or holds a
 * raw `MemoryRepo` handle; that code is trusted (see docs/what-could-be-better.md).
 *
 * GUARDRAIL #2 ("a human approves every send"): `dispatchDraft` is the single
 * function, in this package and in the whole repo, that is allowed to call
 * `OutreachChannel.dispatch`. It is authoritative from the SYSTEM OF RECORD in `memory` — it
 * never trusts the caller-supplied `Draft`/`Approval` objects' own fields. Before it touches the
 * channel it (via `assertDispatchable`, below):
 *   - re-reads the PERSISTED draft by id and refuses if it isn't in the system of record at all
 *   - refuses if the persisted draft's status is already `"dispatched"` (no re-send) or
 *     `"dispatching"` (a send is already in flight for it — no double-send)
 *   - structurally re-checks the PERSISTED draft against the approval via `assertApproved` (an
 *     `Approval` was supplied, `decision === "approve"`, `draftId === draft.id`,
 *     `draft.status === "approved"`) — against the persisted draft, not the caller's copy
 *   - verifies the supplied `Approval` corresponds to a REAL, persisted, hash-chained row in the
 *     `approvals` audit log (not merely an object that *looks like* a valid Approval), and that
 *     the audit chain itself verifies
 * Any violation throws a clear `Error` BEFORE the channel is called — never after, never
 * partially. On a clean check it runs a small STATE MACHINE (see `dispatchDraft`): atomically
 * claim the draft `approved -> dispatching`, call the channel with the PERSISTED draft, and then
 * either advance `dispatching -> dispatched` + persist the canonical `Outcome` row (on success) or
 * revert `dispatching -> approved` + re-throw with NO Outcome (on a channel failure, so a
 * legitimate retry can re-send rather than the send being silently lost). This function — not the
 * channel — is what `memory` learns "sent" from; the channel's own returned Outcome may carry
 * channel-specific metrics, folded in below, but this function owns the row of record.
 *
 * WHY re-derive everything from `memory` instead of trusting the arguments: a caller working
 * from untrusted/deserialized input (or simply a stale in-process object) can construct a
 * `Draft`/`Approval` pair that is internally *consistent* — matching ids, `status:'approved'`,
 * `decision:'approve'` — without either one ever having actually gone through
 * `DraftStore#approve` / `MemoryRepo#appendApproval`. Checking only internal consistency between
 * the two supplied objects cannot tell a forged pair from a real one. Re-reading the draft and
 * requiring the approval to exist as a hash-chained row in `memory` closes that gap: both must be
 * real, on record, decisions this process actually made — not merely well-shaped arguments.
 *
 * `assertApproved` is exported so `channels.ts` implementations can defensively RE-verify the
 * same structural invariant (the seam contract in `@mstack/core`'s `seams.ts` requires every
 * `OutreachChannel` implementation to verify this itself, not just trust its caller) without
 * duplicating the logic. It stays a pure, synchronous, argument-only check — it deliberately does
 * not talk to `memory`; the system-of-record verification lives in `assertDispatchable` /
 * `dispatchDraft` alone, upstream of every channel. Re-asserting in a channel does not create a
 * second "send path" — it is a guard, not a dispatch call; see `dispatch.test.ts`'s guardrail
 * test, which grep-scans this package's production source for actual `*.dispatch(` CALL sites
 * (as opposed to the `dispatch(...)` METHOD DEFINITIONS every channel implementation necessarily
 * has) and asserts there is exactly one, here.
 */
import { newId, nowIso, Outcome, Approval } from "@mstack/core";
import type { Draft } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import { draftContentHash } from "./content-hash.js";

export interface DispatchOptions {
  /** injectable clock; tests only. */
  now?: () => string;
}

/**
 * The pure, argument-level guardrail check: given a `draft` and `approval` already IN HAND, are
 * they structurally consistent with each other? Throws a specific, clear `Error` on the first
 * violation found (checked in this order: missing Approval, wrong decision, wrong draftId, wrong
 * draft status) and otherwise narrows `approval` to non-null for the caller.
 *
 * Deliberately does NOT touch `memory` — on its own it cannot tell a forged `Draft`/`Approval`
 * pair from a real one, since both may be internally consistent while neither was ever persisted.
 * That system-of-record check is `assertDispatchable`'s job (below), which calls this function
 * against the PERSISTED draft as one step among several. This function stays exported and
 * reusable so channel implementations can re-assert the same structural invariant defensively
 * (see file header).
 */
export function assertApproved(
  draft: Draft,
  approval: Approval | undefined | null,
): asserts approval is Approval {
  if (!approval) {
    throw new Error(`dispatchDraft: refused — no Approval supplied for draft "${draft.id}"`);
  }
  if (approval.decision !== "approve") {
    throw new Error(
      `dispatchDraft: refused — Approval "${approval.id}" decision is "${approval.decision}", not "approve"`,
    );
  }
  if (approval.draftId !== draft.id) {
    throw new Error(
      `dispatchDraft: refused — Approval "${approval.id}" is for draft "${String(approval.draftId)}", not "${draft.id}"`,
    );
  }
  if (draft.status !== "approved") {
    throw new Error(
      `dispatchDraft: refused — draft "${draft.id}" has status "${draft.status}", not "approved"`,
    );
  }
}

/**
 * Verifies `draft`/`approval` against the SYSTEM OF RECORD in `memory` and returns the persisted
 * `Draft` row that `dispatchDraft` must use downstream (never the caller-supplied `draft`).
 * Throws a clear `Error` on the first violation found, in this order:
 *
 *   1. the draft isn't in `memory` at all (never saved, or a wrong/forged id)
 *   2. the persisted draft's CURRENT status is already `"dispatched"` (a completed send) or
 *      `"dispatching"` (a send in flight) — refuses either. This closes the realistic (sequential)
 *      double-send / TOCTOU window: re-reading and checking the CURRENT persisted status
 *      immediately before the channel call means a second `dispatchDraft` call for an
 *      already-sent-or-in-flight draft is refused even if the caller still holds an in-memory
 *      `Draft`/`Approval` pair that looks perfectly valid (e.g. reused from the first call).
 *   3. the persisted draft fails the structural `assertApproved` check against `approval` (e.g.
 *      status is still `"pending"`/`"rejected"`, or the approval's `draftId`/`decision` don't
 *      match)
 *   4. the supplied `Approval` does not correspond to a REAL, persisted, hash-chained row in the
 *      `approvals` audit log — `approval.id` isn't on record, or the on-record row's
 *      `decision`/`draftId` don't match, or the audit chain itself doesn't verify. This is what
 *      defeats a FORGED `Approval`: an attacker (or buggy caller) who constructs a
 *      plausible-looking `Draft`/`Approval` pair cannot fabricate a row that both exists in
 *      `approvals` AND satisfies `verifyAuditChain()`, because the hash chain is computed
 *      server-side by `MemoryRepo#appendApproval` from the real insertion order and prior hash —
 *      it cannot be produced by merely constructing a JS object with the right shape. Note this
 *      step re-checks the RECORDED `decision`/`draftId` (from the row in `memory`), not the
 *      caller-supplied `approval`'s own fields — a caller cannot pass off a real approval id for
 *      a *different* draft/decision by lying about the fields on its local copy.
 *
 * DOUBLE-SEND — closed by the read-side gate here PLUS the write-side atomic claim downstream:
 * this function closes the SEQUENTIAL case (the second call re-reads status, sees `"dispatched"`
 * or `"dispatching"`, and is refused). The true concurrent RACE (two `dispatchDraft` calls both
 * reading `"approved"` before either writes) is closed one step downstream by `dispatchDraft`'s
 * ATOMIC claim: `MemoryRepo#claimDraftForDispatch` runs a single `UPDATE drafts SET
 * status='dispatching' WHERE id=$id AND status='approved' RETURNING id` immediately BEFORE the
 * channel call and proceeds only if it changed the row, so at most one caller can ever win — the
 * loser is refused without sending. `assertDispatchable` stays the READ-side gate (existence,
 * persisted status, a real hash-chained approval, the required content binding); the claim is the
 * WRITE-side gate. Both are needed — this check refuses forged/mismatched/tampered inputs before
 * any write; the claim serializes the one legitimate send. Unlike the previous design the claim
 * moves the draft to the intermediate `"dispatching"` state, NOT straight to `"dispatched"`, so a
 * channel failure reverts to a retryable `"approved"` instead of a permanently-lost `"dispatched"`.
 * This holds under the package's single-writer embedded-DuckDB model and remains correct if the
 * backing store later moves to Postgres (the conditional UPDATE is the same atomic primitive there).
 */
export async function assertDispatchable(
  memory: MemoryRepo,
  draft: Draft,
  approval: Approval,
): Promise<Draft> {
  const persisted = await memory.getDraft(draft.id);
  if (!persisted) {
    throw new Error(`dispatchDraft: refused — draft "${draft.id}" is not in the system of record`);
  }
  if (persisted.status === "dispatched") {
    throw new Error(
      `dispatchDraft: refused — draft "${draft.id}" was already dispatched; refusing to send again`,
    );
  }
  if (persisted.status === "dispatching") {
    // A send is already in flight for this draft (or a prior attempt crashed mid-send). Treat
    // `dispatching` as "in progress" and refuse a FRESH dispatch so there is no double-send. A
    // stuck `dispatching` row needs operator re-drive (a timeout-based reclaim is a documented
    // follow-up); this gate does not itself un-stick it.
    throw new Error(
      `dispatchDraft: refused — draft "${draft.id}" is currently being dispatched ` +
        "(status 'dispatching'); refusing a fresh dispatch while a send is in flight",
    );
  }

  assertApproved(persisted, approval);

  const approvalRows = await memory.query<{ data: string }>(
    "SELECT data FROM approvals WHERE id = $id",
    { id: approval.id },
  );
  const approvalRow = approvalRows[0];
  if (!approvalRow) {
    throw new Error(
      `dispatchDraft: refused — Approval "${approval.id}" is not in the system of record ` +
        "(no matching persisted, hash-chained row in the approvals audit log)",
    );
  }

  let recorded: Approval;
  try {
    recorded = Approval.parse(JSON.parse(approvalRow.data));
  } catch {
    throw new Error(
      `dispatchDraft: refused — the persisted row for Approval "${approval.id}" failed to parse`,
    );
  }
  if (recorded.decision !== "approve" || recorded.draftId !== persisted.id) {
    throw new Error(
      `dispatchDraft: refused — the persisted Approval "${approval.id}" does not record an ` +
        `"approve" decision for draft "${persisted.id}"`,
    );
  }

  // Content binding (#2): the send path REQUIRES a content binding, and the persisted draft's
  // CURRENT content must still match it. The RECORDED contentHash (system of record, never the
  // caller's copy) pins every dispatch-relevant field a channel could read — the whole Draft minus
  // `status` (see `draftContentHash`) — so a post-approval swap of subject/body/channel/createdBy/
  // etc. is caught here rather than delivered. A draft approval with NO contentHash is refused
  // outright: going-forward approvals always carry one (`DraftStore#approve`), and an unbound
  // approval cannot prove the persisted content is what the human actually saw. (The `Approval`
  // schema keeps `contentHash` optional ONLY so old rows / non-draft review approvals still parse.)
  if (recorded.contentHash === undefined) {
    throw new Error(
      `dispatchDraft: refused — Approval "${approval.id}" for draft "${persisted.id}" carries no ` +
        "content binding (contentHash); the send path requires one. Re-approve the draft to bind it.",
    );
  }
  if (draftContentHash(persisted) !== recorded.contentHash) {
    throw new Error(
      `dispatchDraft: refused — draft "${persisted.id}" content has changed since it was ` +
        `approved (Approval "${approval.id}" is bound to different content); re-approval required`,
    );
  }

  if (!(await memory.verifyAuditChain())) {
    throw new Error(
      `dispatchDraft: refused — the approval audit chain failed verification; refusing to trust ` +
        `Approval "${approval.id}"`,
    );
  }

  return persisted;
}

/**
 * The only path from a `Draft` to `dispatched` in the normal flow (guardrail #2). Refuses any
 * draft/approval pair that doesn't check out against the SYSTEM OF RECORD (`assertDispatchable`,
 * above) — checked before the channel is ever called.
 *
 * STATE MACHINE (the round-2 fix for the "falsely dispatched on channel failure" regression):
 *   1. `assertDispatchable` — read-side gate. Refuses `dispatched` (re-send) AND in-flight
 *      `dispatching` (a send is already underway), among the other checks.
 *   2. ATOMIC claim `approved -> dispatching` (winner only) — closes the concurrent race and the
 *      double-send. If this call didn't win the claim, refuse WITHOUT sending.
 *   3. call the channel with the pre-claim PERSISTED draft (still status 'approved', so a
 *      channel's defensive `assertApproved` re-check passes).
 *   4a. on SUCCESS: advance `dispatching -> dispatched`, then build + persist + return the
 *       canonical `Outcome` row (`refType:'draft'`, `result:'sent'`).
 *   4b. on channel THROW: the message was NOT sent, so REVERT `dispatching -> approved` (a
 *       legitimate retry can then re-send) and re-throw. NO Outcome is recorded — nothing was sent.
 *
 * Why the intermediate `dispatching` matters: the previous version committed `dispatched` BEFORE
 * the send, so a channel failure left the draft permanently `dispatched` with no Outcome and no
 * possible retry — a silent delivery LOSS mislabeled "fail-closed". `dispatching` lets a failed
 * send fall back to a retryable `approved` while STILL blocking a fresh concurrent/duplicate
 * dispatch (step 1 refuses a `dispatching` draft). A crash between the claim and either transition
 * leaves a stuck `dispatching` row for operator re-drive (documented follow-up: a timeout-based
 * reclaim of stuck `dispatching` rows).
 */
export async function dispatchDraft(
  draft: Draft,
  approval: Approval,
  channel: OutreachChannel,
  memory: MemoryRepo,
  opts: DispatchOptions = {},
): Promise<Outcome> {
  const persisted = await assertDispatchable(memory, draft, approval);

  // ATOMIC claim BEFORE the external send (guardrail #2, double-send race): flip
  // approved->dispatching conditionally and proceed only if THIS call won the claim. This closes
  // the concurrent race (two callers each read 'approved' in assertDispatchable and both try to
  // send) — the loser's conditional UPDATE matches nothing and is refused here.
  const claimed = await memory.claimDraftForDispatch(persisted.id);
  if (!claimed) {
    throw new Error(
      `dispatchDraft: refused — draft "${persisted.id}" could not be claimed for dispatch ` +
        "(already claimed, in-flight, or dispatched by a concurrent or earlier call); refusing to send again",
    );
  }

  // The draft is now 'dispatching' (in-flight). Send using the PRE-claim `persisted` object (still
  // status 'approved') so a channel's defensive assertApproved re-check passes.
  let channelOutcome: Outcome;
  try {
    channelOutcome = await channel.dispatch(persisted, approval);
  } catch (err) {
    // The channel failed => the message was NOT sent. Revert the in-flight claim
    // (dispatching -> approved) so a legitimate retry can re-send, then re-throw. NO Outcome is
    // recorded — nothing was delivered. If the revert itself fails the draft is left 'dispatching'
    // for operator re-drive; surface that, but still propagate the ORIGINAL channel error (the
    // root cause the caller needs to see).
    try {
      await memory.setDraftStatus(persisted.id, "approved");
    } catch (revertErr) {
      console.error(
        `[@mstack/runtime] dispatchDraft: draft "${persisted.id}" send failed AND the ` +
          `dispatching->approved revert failed (${String(revertErr)}); the draft is left ` +
          "'dispatching' and needs operator re-drive.",
      );
    }
    throw err;
  }

  // The send succeeded => commit dispatching -> dispatched, then record the Outcome of record.
  await memory.setDraftStatus(persisted.id, "dispatched");

  const now = opts.now ?? nowIso;
  const outcome = Outcome.parse({
    id: newId("out"),
    refType: "draft",
    refId: persisted.id,
    result: "sent",
    metrics: channelOutcome.metrics,
    ts: now(),
  });
  await memory.putOutcome(outcome);
  return outcome;
}
