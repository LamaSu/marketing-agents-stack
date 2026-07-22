/**
 * tick.ts — advance ALL active runs by one step. A thin scheduler over `advanceSequence`:
 * it loads every `status:"active"` run from the `SequenceStore` and advances each once,
 * returning a per-run summary a CLI/cron can print.
 *
 * PRESERVES THE INVARIANT: this only ever calls `advanceSequence`, which QUEUES a `pending`
 * draft through the draft-first gate (`DraftStore#save`) and NEVER sends. Ticking many runs
 * adds no new send path — every queued draft still exits only through a human `approve()` and
 * `@mstack/runtime`'s `dispatchDraft`. This is orchestration bookkeeping, not a channel.
 *
 * Injectable via the same `AdvanceDeps` as `advanceSequence` (incl. `now`/`hasReplied`), so a
 * scheduler test can force the delay gate open by passing a future `now`.
 */
import { advanceSequence } from "./runner.js";
import type { AdvanceDeps } from "./runner.js";
import type { SequenceRun, SequenceRunStatus } from "./types.js";

/** What happened to one run during a tick. */
export type TickOutcome = "queued" | "stopped" | "completed" | "no_op";

/** Per-run result of a tick — enough for a CLI to print one line per run. */
export interface TickRunSummary {
  runId: string;
  accountRef: string;
  outcome: TickOutcome;
  /** run status AFTER the advance. */
  status: SequenceRunStatus;
  /** `currentStep` AFTER the advance (0-based index of the NEXT step to queue). */
  currentStep: number;
  /** the draft id queued this tick — present only when `outcome === "queued"`. */
  queuedDraftId?: string;
}

export interface TickResult {
  /** how many active runs were examined. */
  runsExamined: number;
  /** how many changed — queued a draft OR transitioned to stopped/completed (excludes no-ops). */
  advanced: number;
  summaries: TickRunSummary[];
}

/**
 * Advance every currently-active run by at most one step. Returns a summary; runs that were
 * not due (delay not elapsed) show up as `no_op` and are not counted in `advanced`.
 *
 * `advanceSequence` itself persists each changed run via `deps.store.saveRun`, so this loop
 * does not re-save — it only reads back the returned (possibly updated) run to classify it.
 */
export async function tickSequences(deps: AdvanceDeps): Promise<TickResult> {
  const runs: SequenceRun[] = await deps.store.listRuns({ status: "active" });
  const summaries: TickRunSummary[] = [];
  let advanced = 0;

  for (const before of runs) {
    const after = await advanceSequence(before, deps);

    // A newly-queued draft is detectable as growth in queuedDraftIds (advanceSequence appends
    // the queued draft's id). noUncheckedIndexedAccess types the element as string|undefined,
    // so the length guard + the explicit undefined check keep this type-safe.
    const newlyQueued =
      after.queuedDraftIds.length > before.queuedDraftIds.length
        ? after.queuedDraftIds[after.queuedDraftIds.length - 1]
        : undefined;

    let outcome: TickOutcome;
    if (newlyQueued !== undefined) {
      outcome = "queued";
    } else if (after.status === "stopped" && before.status !== "stopped") {
      outcome = "stopped";
    } else if (after.status === "completed" && before.status !== "completed") {
      outcome = "completed";
    } else {
      outcome = "no_op";
    }
    if (outcome !== "no_op") advanced++;

    summaries.push({
      runId: after.id,
      accountRef: after.accountRef,
      outcome,
      status: after.status,
      currentStep: after.currentStep,
      ...(newlyQueued !== undefined ? { queuedDraftId: newlyQueued } : {}),
    });
  }

  return { runsExamined: runs.length, advanced, summaries };
}
