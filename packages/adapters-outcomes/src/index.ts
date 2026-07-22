/**
 * @mstack/adapters-outcomes -- the RETURN LEG: `OutcomeSource` implementations that turn
 * reply/meeting/no-response engagement events into `Outcome` rows, closing the loop that
 * `runtime/dispatch.ts` opens at send time. `SampleOutcomeSource` (default, offline),
 * `WebhookOutcomeSource` (push, opt-in), `HttpOutcomeSource` (pull, opt-in), the
 * `outcomeSource(name, config)` factory, and `ingestOutcomes(source, memory)` to persist a
 * pull into `@mstack/memory`. See README.md.
 */
export * from "./outcome-source.js";
export * from "./sample-outcome-source.js";
export * from "./webhook-outcome-source.js";
export * from "./http-outcome-source.js";
export * from "./ingest.js";
export * from "./factory.js";
export * from "./util.js";

export { SampleOutcomeSource as default } from "./sample-outcome-source.js";
