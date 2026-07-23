/**
 * content-hash.ts — the stable hash that binds an `Approval` to the exact draft CONTENT a human
 * approved, so a post-approval content swap (approve body X, `putDraft` body Y, send Y) is caught
 * at the gate rather than delivered.
 *
 * The SAME function both SETS the hash (`DraftStore#approve`) and CHECKS it
 * (`dispatch.ts#assertDispatchable`), so the two can never drift.
 *
 * WHAT IT COVERS: the WHOLE persisted `Draft` MINUS its `status`. Every field a channel — including
 * a custom Composio-style `mapDraft` — could read into an outbound message is bound: subject, body,
 * channel, refId, kind, createdBy, createdAt, id (and any field later added to `Draft`, since it
 * spreads the object rather than listing fields). `status` is the ONE field deliberately excluded:
 * it is control-plane, not content, and legitimately changes across the lifecycle
 * (pending -> approved -> dispatching -> dispatched). Including it would make the approve-time hash
 * (computed over a `pending`/`approved` draft) never equal the send-time hash (checked over an
 * `approved` draft), breaking every legitimate send. Excluding exactly `status` is what keeps the
 * binding both tight (no content field escapes) and stable (ordinary status transitions don't
 * spuriously invalidate an unchanged draft).
 *
 * `canonicalJson` (key-sorted, deterministic) is reused from `@mstack/memory` so this hash is
 * order-independent, exactly like the audit chain's. This hash is INDEPENDENT of the audit-chain
 * hash — it pins content, not chain linkage.
 */
import { sha256Hex } from "@mstack/core";
import type { Draft } from "@mstack/core";
import { canonicalJson } from "@mstack/memory";

/** sha256 of the dispatch-relevant content of a draft: the whole persisted Draft minus `status`. */
export function draftContentHash(draft: Draft): string {
  // Spread + delete (rather than an explicit field list) so any field added to `Draft` in future
  // is bound automatically and cannot silently escape the content binding.
  const content: Record<string, unknown> = { ...draft };
  delete content.status;
  return sha256Hex(canonicalJson(content));
}
