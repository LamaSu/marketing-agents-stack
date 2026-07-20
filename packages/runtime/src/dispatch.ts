/**
 * dispatch.ts — the ONLY send path in this repo (research/06-architecture.md §3.3, §8
 * guardrail #2; docs/build-conventions.md guardrail #2).
 *
 * MECHANICAL GUARDRAIL #2 ("a human approves every send"): `dispatchDraft` is the single
 * function, in this package and in the whole repo, that is allowed to call
 * `OutreachChannel.dispatch`. Before it touches the channel it asserts ALL of:
 *   - an `Approval` was actually supplied
 *   - `approval.decision === "approve"`
 *   - `approval.draftId === draft.id`
 *   - `draft.status === "approved"`
 * Any violation throws a clear `Error` BEFORE the channel is called — never after, never
 * partially. On success: call the channel, mark the draft `dispatched` in memory, then build,
 * persist, and return the canonical `Outcome` row (this function — not the channel — is what
 * `memory` learns "sent" from; the channel's own returned Outcome may carry channel-specific
 * metrics, folded in below, but this function owns the row of record).
 *
 * `assertApproved` is exported so `channels.ts` implementations can defensively RE-verify the
 * same invariant (the seam contract in `@mstack/core`'s `seams.ts` requires every
 * `OutreachChannel` implementation to verify this itself, not just trust its caller) without
 * duplicating the logic. Re-asserting in a channel does not create a second "send path" — it
 * is a guard, not a dispatch call; see `dispatch.test.ts`'s guardrail test, which grep-scans
 * this package's production source for actual `*.dispatch(` CALL sites (as opposed to the
 * `dispatch(...)` METHOD DEFINITIONS every channel implementation necessarily has) and asserts
 * there is exactly one, here.
 */
import { newId, nowIso, Outcome } from "@mstack/core";
import type { Approval, Draft } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

export interface DispatchOptions {
  /** injectable clock; tests only. */
  now?: () => string;
}

/**
 * The single guardrail check. Throws a specific, clear `Error` on the first violation found
 * (checked in this order: missing Approval, wrong decision, wrong draftId, wrong draft
 * status) and otherwise narrows `approval` to non-null for the caller. Exported so channel
 * implementations can re-assert the same invariant defensively (defense in depth — see the
 * file header).
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
 * THE ONLY PATH FROM A `Draft` TO `dispatched` (guardrail #2). Refuses any draft lacking a
 * matching, approved `Approval` — checked before the channel is ever called. On success:
 * dispatch via the channel, mark the draft `dispatched` in `memory`, then build + persist +
 * return the `Outcome` row (`refType:'draft'`, `result:'sent'`).
 */
export async function dispatchDraft(
  draft: Draft,
  approval: Approval,
  channel: OutreachChannel,
  memory: MemoryRepo,
  opts: DispatchOptions = {},
): Promise<Outcome> {
  assertApproved(draft, approval);

  const channelOutcome = await channel.dispatch(draft, approval);
  await memory.setDraftStatus(draft.id, "dispatched");

  const now = opts.now ?? nowIso;
  const outcome = Outcome.parse({
    id: newId("out"),
    refType: "draft",
    refId: draft.id,
    result: "sent",
    metrics: channelOutcome.metrics,
    ts: now(),
  });
  await memory.putOutcome(outcome);
  return outcome;
}
