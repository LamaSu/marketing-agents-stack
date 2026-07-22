/**
 * OutcomeSource -- the return-leg analogue of `@mstack/core`'s `SignalSource` seam
 * (see packages/core/src/seams.ts). `SignalSource` is the ingest atom producer for the
 * FORWARD leg (a signal arrives, an account gets scored, a draft gets sent); `OutcomeSource`
 * is the ingest atom producer for the RETURN leg -- what happened after a `Draft`/`Decision`/
 * `Review` acted on the world (a reply landed, a meeting got booked, nothing came back).
 *
 * Deliberately package-local, NOT added to `@mstack/core`'s `seams.ts`: `Outcome` rows are
 * already produced today by `runtime/dispatch.ts` at SEND time (`result:"sent"`, written
 * synchronously as part of the one send path -- see that file's header). This seam is for
 * everything that arrives AFTER that -- asynchronously, from an external system (an ESP/CRM
 * webhook, a polled endpoint) -- which is a distinct ingestion concern from the send path,
 * the same way `SignalSource` is a distinct ingestion concern from `EnrichmentProvider`.
 * Keeping the interface here (rather than editing core's seams.ts) avoids widening the
 * shared contract surface for a concern only this package currently implements; if/when
 * another package needs the same shape, promoting it to core is a one-line move (the
 * interface is structurally identical to `SignalSource`, just over `Outcome` instead of
 * `Signal`).
 *
 * Every implementation in this package returns `Outcome[]` -- the one closed-loop primitive
 * (`@mstack/core`'s `Outcome` schema) the rest of the stack already reasons about via
 * `MemoryRepo.putOutcome` -- so swapping the offline sample for a real ESP/CRM source is a
 * one-line registration change (`factory.ts`) with nothing downstream touched. See
 * `ingest.ts`'s `ingestOutcomes` for the pull -> putOutcome wiring that actually closes the
 * loop into `@mstack/memory`.
 */
import type { Outcome, PullOptions } from "@mstack/core";

/**
 * The return-leg ingest seam. Structurally identical to `SignalSource` (core/seams.ts),
 * specialized to `Outcome`. `PullOptions` (imported from `@mstack/core`, already
 * Signal-agnostic -- `{ since?: string; limit?: number }`) is reused as-is rather than
 * redeclared, so both seams speak the same pull-options vocabulary.
 */
export interface OutcomeSource {
  readonly name: string;
  pull(opts?: PullOptions): Promise<Outcome[]>;
}
