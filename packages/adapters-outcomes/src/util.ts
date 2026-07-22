/**
 * Small shared helpers for the outcome sources in this package. `applyPullOptions` mirrors
 * packages/adapters-signals/src/util.ts's helper of the same name, specialized to `Outcome`
 * instead of `Signal` -- kept as this package's OWN copy rather than importing
 * adapters-signals, so `@mstack/adapters-outcomes` has no dependency on its sibling adapter
 * package (each adapter package stays independently installable).
 */
import type { Outcome, PullOptions } from "@mstack/core";

/**
 * Shared post-filter applied once a source has its Outcomes in hand -- either already
 * buffered in memory (`SampleOutcomeSource`'s loaded fixture, `WebhookOutcomeSource`'s
 * ingest buffer) or just fetched from a remote endpoint (`HttpOutcomeSource`, as a
 * defensive double-check on top of pushing `since`/`limit` into the request itself --
 * never trust a third-party endpoint to honor query params correctly). Applies `since`
 * (ts >= since) then `limit` (first N after the since-filter) the same way everywhere.
 */
export function applyPullOptions(outcomes: readonly Outcome[], opts?: PullOptions): Outcome[] {
  const since = opts?.since;
  const limit = opts?.limit;
  let result = since ? outcomes.filter((o) => o.ts >= since) : [...outcomes];
  if (limit !== undefined) result = result.slice(0, limit);
  return result;
}
