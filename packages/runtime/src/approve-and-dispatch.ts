/**
 * approve-and-dispatch.ts — the human-gated completion of the draft-first loop
 * (research/06-architecture.md §3.3, §8 guardrail #2). Everything upstream of this file
 * (`workflows/content-review.ts`, `workflows/account-activation.ts`) only ever produces
 * `pending` drafts; this is the one place a human's "approve" decision is turned into an
 * actual dispatch.
 */
import type { Approval, Outcome } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import { dispatchDraft } from "./dispatch.js";
import type { DraftStore } from "./draft-store.js";

export interface ApproveAndDispatchDeps {
  memory: MemoryRepo;
  draftStore: DraftStore;
}

/**
 * approve -> getDraft -> dispatchDraft. Records the (hash-chained) approval first, re-reads
 * the draft (now `status:'approved'`) so `dispatchDraft`'s invariant check has the post-approval
 * state to check against, then performs the one send this package permits.
 */
export async function approveAndDispatch(
  draftId: string,
  actor: string,
  channel: OutreachChannel,
  deps: ApproveAndDispatchDeps,
): Promise<Outcome> {
  const approval = await deps.draftStore.approve(draftId, actor);

  const draft = await deps.memory.getDraft(draftId);
  if (!draft) {
    throw new Error(
      `approveAndDispatch: draft "${draftId}" not found in memory after being approved`,
    );
  }

  return dispatchDraft(draft, approval, channel, deps.memory);
}

/**
 * A human rejects the draft. No channel involved, nothing dispatches — the draft moves to
 * `rejected` and a `reject` `Approval` row is recorded (still hash-chained; rejections are
 * part of the audit trail too).
 */
export async function rejectDraft(
  draftId: string,
  actor: string,
  deps: Pick<ApproveAndDispatchDeps, "draftStore">,
): Promise<Approval> {
  return deps.draftStore.reject(draftId, actor);
}
