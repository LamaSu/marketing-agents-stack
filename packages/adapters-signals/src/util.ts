/**
 * Small shared helpers for the signal adapters in this package. See
 * research/06-architecture.md §5.1 (SignalSource seam) and research/tools/A-signals-ingestion.md
 * (the adapter list + rationale this package implements).
 */
import type { PullOptions, Signal } from "@mstack/core";

/**
 * Shared post-filter for sources that already hold their Signals in memory (SampleSource's
 * loaded fixture, SegmentWebhookSource's ingest buffer): apply `since` (ts >= since) then
 * `limit` (first N after the since-filter) the same way in both places. Sources that query an
 * external system instead (PostHogSource, GitHubSignalSource, SqlWarehouseSource) push
 * `since`/`limit` down into the query/request itself and do not use this helper.
 */
export function applyPullOptions(signals: readonly Signal[], opts?: PullOptions): Signal[] {
  const since = opts?.since;
  const limit = opts?.limit;
  let result = since ? signals.filter((s) => s.ts >= since) : [...signals];
  if (limit !== undefined) result = result.slice(0, limit);
  return result;
}

/** `value` if it's a non-empty string, else undefined -- for pulling optional fields out of
 *  loosely-typed third-party payloads (Segment traits, PostHog person properties) without
 *  spraying `typeof x === "string" ? x : undefined` at every call site. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
