/**
 * ingestOutcomes -- pulls from any `OutcomeSource` and persists each row into the shared
 * `@mstack/memory` warehouse via `MemoryRepo.putOutcome`. This is the wiring that actually
 * closes the loop: once outcomes land in `memory`'s `outcomes` table, they're queryable by
 * anything downstream that already knows how to read `memory` -- an outreach-sequence
 * runner can check "has this refId's draft gotten a reply yet?" before sending the next
 * step, the qualifier can join outcomes to accounts/signals for a stronger-than-Approval-
 * decision training label, and the analytics/funnel view can aggregate `result` counts over
 * time -- all via `MemoryRepo.query()`, no new read path required.
 *
 * Dedupe: `MemoryRepo.putOutcome` -> `upsertRow` already does `DELETE ... WHERE id = $id`
 * before every `INSERT`, so re-ingesting the same `Outcome.id` is naturally idempotent at
 * the storage layer (same id in, same row out, never a duplicate row). This function adds
 * an IN-BATCH dedupe on top: if a single `pull()` call returns the same id twice (a buggy or
 * duplicate-delivering source), only the FIRST occurrence is written and the rest are
 * reported in `skippedDuplicateIds` rather than silently re-writing the same row N times in
 * one pass.
 */
import type { PullOptions } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import type { OutcomeSource } from "./outcome-source.js";

export interface IngestOutcomesResult {
  /** how many Outcome rows the source's pull() returned. */
  pulled: number;
  /** how many were actually written via putOutcome (pulled minus in-batch duplicates). */
  ingested: number;
  /** ids seen more than once within this single pull -- written once (first occurrence),
   *  reported here rather than silently re-written. */
  skippedDuplicateIds: string[];
}

/**
 * The minimal surface `ingestOutcomes` needs from a memory repo -- `Pick<MemoryRepo, ...>`
 * rather than the full class, so a caller can pass a lightweight stand-in if it ever needs
 * to. This package's own tests use the real `MemoryRepo` against `:memory:` (per
 * docs/build-conventions.md's "DuckDB is the real dependency" convention and
 * memory-repo.test.ts's own setup pattern) -- this narrower type is a convenience for
 * callers, not a signal to fake persistence in this package's tests.
 */
export type OutcomeSink = Pick<MemoryRepo, "putOutcome">;

/**
 * Pulls `source.pull(opts)` and writes each Outcome to `memory` in order, skipping any id
 * already seen earlier in the SAME batch. Safe to call repeatedly on a schedule (cron/poll)
 * -- re-running with overlapping or identical source data never creates duplicate rows,
 * because the underlying `putOutcome` upsert is itself idempotent by id.
 */
export async function ingestOutcomes(
  source: OutcomeSource,
  memory: OutcomeSink,
  opts?: PullOptions,
): Promise<IngestOutcomesResult> {
  const outcomes = await source.pull(opts);
  const seen = new Set<string>();
  const skippedDuplicateIds: string[] = [];
  let ingested = 0;

  for (const outcome of outcomes) {
    if (seen.has(outcome.id)) {
      skippedDuplicateIds.push(outcome.id);
      continue;
    }
    seen.add(outcome.id);
    await memory.putOutcome(outcome);
    ingested++;
  }

  return { pulled: outcomes.length, ingested, skippedDuplicateIds };
}
