/**
 * dispatch.ts — the ONLY send path in this repo (research/06-architecture.md §3.3, §8
 * guardrail #2; docs/build-conventions.md guardrail #2).
 *
 * MECHANICAL GUARDRAIL #2 ("a human approves every send"): `dispatchDraft` is the single
 * function, in this package and in the whole repo, that is allowed to call
 * `OutreachChannel.dispatch`. It is authoritative from the SYSTEM OF RECORD in `memory` — it
 * never trusts the caller-supplied `Draft`/`Approval` objects' own fields. Before it touches the
 * channel it (via `assertDispatchable`, below):
 *   - re-reads the PERSISTED draft by id and refuses if it isn't in the system of record at all
 *   - refuses if the persisted draft's status is already `"dispatched"` (no re-send)
 *   - structurally re-checks the PERSISTED draft against the approval via `assertApproved` (an
 *     `Approval` was supplied, `decision === "approve"`, `draftId === draft.id`,
 *     `draft.status === "approved"`) — against the persisted draft, not the caller's copy
 *   - verifies the supplied `Approval` corresponds to a REAL, persisted, hash-chained row in the
 *     `approvals` audit log (not merely an object that *looks like* a valid Approval), and that
 *     the audit chain itself verifies
 * Any violation throws a clear `Error` BEFORE the channel is called — never after, never
 * partially. On success: call the channel with the PERSISTED draft, mark it `dispatched` in
 * memory, then build, persist, and return the canonical `Outcome` row (this function — not the
 * channel — is what `memory` learns "sent" from; the channel's own returned Outcome may carry
 * channel-specific metrics, folded in below, but this function owns the row of record).
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
 *   2. the persisted draft's CURRENT status is already `"dispatched"` — refuses a re-send. This
 *      is what closes the realistic (sequential) double-send / TOCTOU window: re-reading and
 *      checking the CURRENT persisted status immediately before the channel call means a second
 *      `dispatchDraft` call for an already-dispatched draft is refused even if the caller still
 *      holds an in-memory `Draft`/`Approval` pair that looks perfectly valid (e.g. reused from
 *      the first, successful call).
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
 * RESIDUAL, DOCUMENTED (not fixed here — see rationale): this closes the realistic SEQUENTIAL
 * double-send (dispatch, then dispatch again) because the second call re-reads status and sees
 * `"dispatched"`. It does NOT close a true RACE of two concurrent `dispatchDraft` calls for the
 * SAME draft that both read the persisted status as `"approved"` before either has written
 * `"dispatched"` (classic check-then-act TOCTOU). Fully closing that would need an atomic
 * conditional update — e.g. `UPDATE drafts SET status='dispatched' WHERE id=$id AND
 * status='approved'`, checking the affected-row count BEFORE the channel call — which
 * `MemoryRepo#setDraftStatus` does not provide today (it is unconditional). Under this package's
 * actual deployment model — single-writer embedded DuckDB (see the file-header note in
 * `memory-repo.ts`) plus a runtime that serializes calls through one shared `MemoryRepo` instance
 * per process — genuinely concurrent writers are already out of scope, so the practical risk is
 * the sequential case, which this closes. If/when the backing store moves to Postgres under
 * concurrent writers (the documented swap-out path in `memory-repo.ts`), add the atomic
 * conditional update at that time rather than over-engineering it into today's single-writer
 * path.
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

  // Content binding (#2): if the recorded Approval pinned the approved content, the
  // persisted draft's CURRENT content must still match it. Otherwise the subject/body/
  // channel/etc. was swapped AFTER approval and this send would deliver content no human
  // approved. Uses the RECORDED contentHash (system of record), never the caller's copy.
  // Approvals with no contentHash (older rows, review approvals) are unaffected.
  if (recorded.contentHash !== undefined && draftContentHash(persisted) !== recorded.contentHash) {
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
 * THE ONLY PATH FROM A `Draft` TO `dispatched` (guardrail #2). Refuses any draft/approval pair
 * that doesn't check out against the SYSTEM OF RECORD (`assertDispatchable`, above) — checked
 * before the channel is ever called. On success: dispatch via the channel using the PERSISTED
 * draft, mark the draft `dispatched` in `memory`, then build + persist + return the `Outcome` row
 * (`refType:'draft'`, `result:'sent'`).
 */
export async function dispatchDraft(
  draft: Draft,
  approval: Approval,
  channel: OutreachChannel,
  memory: MemoryRepo,
  opts: DispatchOptions = {},
): Promise<Outcome> {
  const persisted = await assertDispatchable(memory, draft, approval);

  const channelOutcome = await channel.dispatch(persisted, approval);
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
