/**
 * draft-store.ts — the ONLY way a `Draft` enters or leaves the `pending` state in this repo
 * (research/06-architecture.md §3.3, §8 guardrail #2).
 *
 * `save()` always forces `status:'pending'` — no caller of this class can hand it a
 * pre-approved draft and skip the human gate. `approve()`/`reject()` append a hash-chained
 * `Approval` row via `MemoryRepo#appendApproval` (which owns the actual prevHash/hash
 * computation — see `@mstack/memory`'s `memory-repo.ts`; this class deliberately does not
 * duplicate that logic) and then flip the draft's status. Neither method ever calls a
 * channel — that is `dispatch.ts`'s job alone, downstream of `approve()`.
 *
 * ADDITIVE (Wave C4, research/10-sota-integration-design.md §2.9): `save()` may ring an
 * optional `ApproverNotifier` (default `noopApproverNotifier`) AFTER the pending draft is
 * persisted — a best-effort "a draft is pending" DOORBELL (e.g. HumanLayer Slack/email).
 * It is the doorbell, NOT the ledger: it cannot approve, dispatch, or change status, and
 * a throwing/hanging notifier is swallowed so it can never affect the persisted draft or
 * the approval gate. The record is still `approve()`'s hash-chained `Approval`; the only
 * send is still `dispatch.ts`. Default is the no-op, so the offline path is unchanged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Draft, newId, nowIso } from "@mstack/core";
import type { Approval } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import { noopApproverNotifier } from "./approver-notifier.js";
import type { ApproverNotifier } from "./approver-notifier.js";
import { draftContentHash } from "./content-hash.js";

const DEFAULT_DRAFTS_DIR = "./drafts";

function resolveDraftsDir(explicit?: string): string {
  return explicit ?? process.env.DRAFTS_DIR ?? DEFAULT_DRAFTS_DIR;
}

export class DraftStore {
  readonly #memory: MemoryRepo;
  readonly #draftsDir: string;
  readonly #notifier: ApproverNotifier;

  /**
   * @param notifier OPTIONAL "a draft is pending" doorbell, rung by `save()` after the
   *   draft is persisted. Defaults to `noopApproverNotifier` (does nothing) so existing
   *   callers and the offline demo are unchanged. Never part of the approval gate.
   */
  constructor(
    memory: MemoryRepo,
    draftsDir?: string,
    notifier: ApproverNotifier = noopApproverNotifier,
  ) {
    this.#memory = memory;
    this.#draftsDir = resolveDraftsDir(draftsDir);
    this.#notifier = notifier;
  }

  /**
   * Persist a candidate action. Always lands `status:'pending'` regardless of what the caller
   * passed in `draft.status` — this is the mechanical half of "nothing is ever pre-approved."
   * Writes both to `memory` (the queryable system of record) and to
   * `<draftsDir>/<id>.json` (the human-facing, glanceable file the README's `ls drafts/` step
   * points at).
   */
  async save(draft: Draft): Promise<Draft> {
    const parsed = Draft.parse({ ...draft, status: "pending" });
    await this.#memory.putDraft(parsed);
    await this.#writeDraftFile(parsed);
    // Best-effort DOORBELL (opt-in `ApproverNotifier`; default no-op => offline unchanged).
    // The draft is ALREADY the system of record above; notifying is supplementary and is
    // wrapped so a throwing/hanging notifier can NEVER undo a safely-`pending` draft or
    // touch the approval gate. HumanLayer is the doorbell, not the ledger — `approve()`/
    // `reject()` below and `dispatch.ts` remain the record + the only send path.
    try {
      await this.#notifier.notifyPending(parsed);
    } catch (err) {
      console.warn(
        `[@mstack/runtime] DraftStore.save: approver notifier threw for draft "${parsed.id}" ` +
          `(${String(err)}); the draft is safely pending regardless (doorbell, not ledger).`,
      );
    }
    return parsed;
  }

  /** All drafts currently awaiting a human decision, oldest first. */
  async listPending(): Promise<Draft[]> {
    const rows = await this.#memory.query<{ data: string }>(
      "SELECT data FROM drafts WHERE status = $status ORDER BY created_at ASC",
      { status: "pending" },
    );
    return rows.map((r) => Draft.parse(JSON.parse(r.data)));
  }

  /**
   * A human approves draft `draftId`. Appends an `approve` `Approval` row (hash-chained by
   * `memory.appendApproval`) and flips the draft to `status:'approved'` — the ONLY status
   * `dispatch.ts#dispatchDraft` will accept. Does not dispatch anything itself.
   *
   * Refuses a draft that is already `status:'dispatched'`. Without this check, re-approving an
   * already-sent draft would flip its status back to `'approved'`, and `dispatchDraft`'s own
   * guard (which only checks the CURRENT status, not history) would then accept a second
   * `approveAndDispatch` call and dispatch it again — a real double-send. Also refuses a draft
   * that is currently `status:'dispatching'` (a send is IN FLIGHT): approving it would yank it
   * back to `'approved'` mid-send, and a concurrent dispatch could then claim and send it a second
   * time. Re-approving from `'pending'` (the normal path), `'approved'` (an idempotent retry after
   * e.g. a transient channel failure that reverted the draft), or `'rejected'` (a human reversing
   * an earlier rejection) are all legitimate and remain allowed; only in-flight and post-dispatch
   * states are refused.
   */
  async approve(draftId: string, actor: string): Promise<Approval> {
    const draft = await this.#memory.getDraft(draftId);
    if (!draft) {
      throw new Error(`DraftStore.approve: no draft with id "${draftId}"`);
    }
    if (draft.status === "dispatched") {
      throw new Error(
        `DraftStore.approve: refused — draft "${draftId}" was already dispatched; approving it ` +
          "again would risk a duplicate send",
      );
    }
    if (draft.status === "dispatching") {
      throw new Error(
        `DraftStore.approve: refused — draft "${draftId}" is currently being dispatched ` +
          "(status 'dispatching'); wait for the in-flight send to settle (it ends 'dispatched' on " +
          "success or reverts to 'approved' on failure) before approving again",
      );
    }
    // Bind this approval to the CONTENT being approved (#2): the hash of the draft's
    // dispatch-relevant fields as they are right now. dispatch.ts recomputes it against
    // the persisted draft at send time and refuses if the content was swapped since.
    const approval = await this.#memory.appendApproval({
      id: newId("appr"),
      draftId,
      decision: "approve",
      actor,
      contentHash: draftContentHash(draft),
      ts: nowIso(),
    });
    await this.#memory.setDraftStatus(draftId, "approved");
    return approval;
  }

  /**
   * A human rejects draft `draftId`. Appends a `reject` `Approval` row (still hash-chained —
   * rejections are part of the audit trail too) and flips the draft to `status:'rejected'`.
   * A rejected draft can never reach `dispatchDraft` (which requires `status:'approved'`).
   *
   * Refuses a draft that is already `status:'dispatched'` — for the same reason `approve()`
   * does: the send already happened, and the audit trail should not claim otherwise. Also refuses
   * a `status:'dispatching'` draft: rejecting mid-send could revert an in-flight send's bookkeeping
   * and race the dispatch's own status transitions — wait for the send to settle first.
   */
  async reject(draftId: string, actor: string): Promise<Approval> {
    const draft = await this.#memory.getDraft(draftId);
    if (!draft) {
      throw new Error(`DraftStore.reject: no draft with id "${draftId}"`);
    }
    if (draft.status === "dispatched") {
      throw new Error(
        `DraftStore.reject: refused — draft "${draftId}" was already dispatched; it cannot be rejected after the fact`,
      );
    }
    if (draft.status === "dispatching") {
      throw new Error(
        `DraftStore.reject: refused — draft "${draftId}" is currently being dispatched ` +
          "(status 'dispatching'); wait for the in-flight send to settle before rejecting",
      );
    }
    const approval = await this.#memory.appendApproval({
      id: newId("appr"),
      draftId,
      decision: "reject",
      actor,
      ts: nowIso(),
    });
    await this.#memory.setDraftStatus(draftId, "rejected");
    return approval;
  }

  async #writeDraftFile(draft: Draft): Promise<void> {
    await mkdir(this.#draftsDir, { recursive: true });
    const filePath = join(this.#draftsDir, `${draft.id}.json`);
    await writeFile(filePath, JSON.stringify(draft, null, 2), "utf8");
  }
}
