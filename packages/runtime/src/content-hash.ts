/**
 * content-hash.ts — the stable hash that binds an `Approval` to the exact draft
 * CONTENT a human approved, so a post-approval content swap (approve body X,
 * `putDraft` body Y, send Y) is caught at the gate rather than delivered.
 *
 * The SAME function both SETS the hash (`DraftStore#approve`) and CHECKS it
 * (`dispatch.ts#assertDispatchable`), so the two can never drift. It hashes only
 * the dispatch-relevant slice of a draft — the fields a channel actually sends —
 * not volatile bookkeeping (id/status/createdAt/createdBy), so ordinary
 * re-approval bookkeeping never spuriously invalidates an unchanged draft.
 *
 * `canonicalJson` (key-sorted, deterministic) is reused from `@mstack/memory` so
 * this hash is order-independent, exactly like the audit chain's. This hash is
 * INDEPENDENT of the audit-chain hash — it pins content, not chain linkage.
 */
import { sha256Hex } from "@mstack/core";
import type { Draft } from "@mstack/core";
import { canonicalJson } from "@mstack/memory";

/** sha256 of the dispatch-relevant content of a draft (subject/body/channel/refId/kind). */
export function draftContentHash(
  draft: Pick<Draft, "subject" | "body" | "channel" | "refId" | "kind">,
): string {
  return sha256Hex(
    canonicalJson({
      subject: draft.subject,
      body: draft.body,
      channel: draft.channel,
      refId: draft.refId,
      kind: draft.kind,
    }),
  );
}
