/**
 * @mstack/runtime — the draft-first dispatch gate + the two HITL workflows that wire the
 * product agents into the signal -> decision -> action loop
 * (research/06-architecture.md §3.3, §4).
 *
 * MECHANICAL GUARDRAIL #2 ("a human approves every send", docs/build-conventions.md): this
 * package is the ONLY place in the repo an `OutreachChannel.dispatch` call is made
 * (`dispatch.ts#dispatchDraft`), and it refuses any `Draft` lacking a matching, `approved`
 * `Approval`. See README.md for the full guardrail write-up.
 */
export * from "./dispatch.js";
export * from "./draft-store.js";
export * from "./channels.js";
export * from "./approve-and-dispatch.js";
export * from "./workflows/content-review.js";
export * from "./workflows/account-activation.js";
export * from "./executor.js";
export * from "./hatchet-executor.js";
export * from "./chorus-adapter.js";
