/**
 * @mstack/sequences — a multi-step SEQUENCE / CADENCE engine (Outreach/Salesloft's core
 * capability), with our differentiator: it NEVER auto-sends.
 *
 * Each step of a cadence produces a `Draft` that lands `pending` in the EXISTING draft-first
 * gate (`@mstack/runtime`'s `DraftStore#save`). A human still approves every send, and
 * `dispatchDraft` (guardrail #2) remains the one and only send path. A sequence here is an
 * ORCHESTRATION that queues drafts over time — it cannot bypass `DraftStore#approve` or the
 * signed, hash-chained `Approval`. See README.md for the full boundary write-up.
 */
export * from "./types.js";
export * from "./render.js";
export * from "./store.js";
export * from "./runner.js";
export * from "./example.js";
