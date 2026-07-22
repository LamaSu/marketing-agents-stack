/**
 * runner.ts — the cadence engine. `advanceSequence` moves ONE run forward by at most one step.
 *
 * THE INVARIANT (parity with Outreach/Salesloft, PLUS our differentiator): a sequence NEVER
 * auto-sends. When a step is due, this runner renders it into a `Draft` and hands it to
 * `DraftStore#save`, which forces `status:'pending'` — landing it in the EXISTING draft-first
 * gate. It does NOT call a channel, it does NOT call `dispatchDraft`, and it does NOT write an
 * `Approval`. A human still approves every draft, and `@mstack/runtime`'s `dispatchDraft`
 * (guardrail #2, the one send path) remains the only way a draft ever reaches `dispatched`.
 * A cadence here is an ORCHESTRATION that QUEUES drafts over time — it cannot bypass
 * `DraftStore#approve` or the signed, hash-chained `Approval`. (Outreach auto-sends; we
 * queue-for-approval — that boundary is the whole point.)
 *
 * The wait/schedule between steps goes through the injected `Executor` seam so an opt-in
 * `HatchetExecutor` can make the cadence durable (crash-resume); the offline default
 * `DirectExecutor` runs it in-process with no network. Wrapping a step in a durable engine
 * adds no new way to send — the queued draft still exits only through the gate.
 */
import { Draft, Outcome, newId } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";
import type { DraftStore, Executor } from "@mstack/runtime";

import { renderTemplate } from "./render.js";
import type { SequenceStore } from "./store.js";
import { SequenceRun, type Sequence } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Everything `advanceSequence` needs, all injectable so the whole engine runs offline. */
export interface AdvanceDeps {
  /** The shared warehouse — read Outcomes for reply-detection. */
  memory: MemoryRepo;
  /** The draft-first gate. `save()` forces `status:'pending'`; it is the ONLY exit for a step. */
  drafts: DraftStore;
  /** Persists the run after each advance. */
  store: SequenceStore;
  /** Durable-wait seam. `DirectExecutor` (offline default) runs the queue step inline. */
  executor: Executor;
  /** Injectable clock (tests). Defaults to real wall-clock time. */
  now?: () => Date;
  /**
   * Override reply-detection. Default (`defaultHasReplied`) queries the run's own queued
   * drafts' Outcomes for a `replied`/`meeting` result. Injectable for tests or an alternate
   * join strategy. Read-only either way — reply-detection never sends anything.
   */
  hasReplied?: (run: SequenceRun, memory: MemoryRepo) => Promise<boolean>;
}

/**
 * Has the account on this run replied? Reads Outcomes for the drafts this run has already
 * queued (an `Outcome` references a DRAFT id, not an account, so we join through the run's own
 * `queuedDraftIds`). Returns true on the first `replied`/`meeting` result. Pure read — it uses
 * `MemoryRepo#query` against the `outcomes` table (`ref_id` is indexed) and never writes.
 */
export async function defaultHasReplied(run: SequenceRun, memory: MemoryRepo): Promise<boolean> {
  for (const draftId of run.queuedDraftIds) {
    const rows = await memory.query<{ data: string }>(
      "SELECT data FROM outcomes WHERE ref_id = $refId",
      { refId: draftId },
    );
    for (const row of rows) {
      const outcome = Outcome.parse(JSON.parse(String(row.data)));
      if (outcome.result === "replied" || outcome.result === "meeting") return true;
    }
  }
  return false;
}

/** Build a fresh `SequenceRun` enrolling `accountRef` into `sequence` (does not persist). */
export function startSequenceRun(
  sequence: Sequence,
  accountRef: string,
  opts?: { now?: () => Date; id?: string },
): SequenceRun {
  const nowIso = (opts?.now?.() ?? new Date()).toISOString();
  return SequenceRun.parse({
    id: opts?.id ?? newId("seqrun"),
    sequenceId: sequence.id,
    accountRef,
    currentStep: 0,
    status: "active",
    startedAt: nowIso,
    lastStepAt: nowIso,
    queuedDraftIds: [],
  });
}

/**
 * Advance ONE run by at most one step. Returns the (possibly updated) run.
 *
 * The run's `Sequence` template is resolved from `deps.store` by `run.sequenceId`, so a
 * scheduler can iterate over run rows and call `advanceSequence(run, deps)` without also
 * carrying the templates. (Save the sequence via `SequenceStore#saveSequence` before enrolling
 * runs into it.)
 *
 *   - not `active`            -> terminal; returned unchanged (no write)
 *   - current step honors replies AND a reply/meeting Outcome exists -> `stopped`
 *   - current step's `delayDays` not yet elapsed since `lastStepAt` -> no-op (no write)
 *   - otherwise               -> render + QUEUE a pending Draft via the gate, advance the
 *                                step, and mark `completed` when the last step is queued
 *
 * Persists the run via `deps.store` whenever it changes; a pure no-op does not write.
 */
export async function advanceSequence(run: SequenceRun, deps: AdvanceDeps): Promise<SequenceRun> {
  // A run only moves while active. Stopped/completed runs are terminal.
  if (run.status !== "active") return run;

  const sequence = await deps.store.getSequence(run.sequenceId);
  if (!sequence) {
    throw new Error(
      `advanceSequence: no sequence "${run.sequenceId}" on record for run "${run.id}"`,
    );
  }

  const steps = [...sequence.steps].sort((a, b) => a.order - b.order);

  // Defensive: nothing left to queue => complete.
  const step = run.currentStep < steps.length ? steps[run.currentStep] : undefined;
  if (!step) {
    return deps.store.saveRun(SequenceRun.parse({ ...run, status: "completed" }));
  }

  // STOP-IF-REPLIED: read Outcomes; if the account replied and this step honors that, stop
  // BEFORE queuing anything. This is the cadence "stop on reply" — done by reading, not sending.
  if (step.stopIfReplied) {
    const replied = deps.hasReplied
      ? await deps.hasReplied(run, deps.memory)
      : await defaultHasReplied(run, deps.memory);
    if (replied) {
      return deps.store.saveRun(SequenceRun.parse({ ...run, status: "stopped" }));
    }
  }

  // DELAY GATE: is this step due yet? (delay measured from the previous step / the start)
  const now = deps.now?.() ?? new Date();
  const elapsedMs = now.getTime() - Date.parse(run.lastStepAt);
  if (elapsedMs < step.delayDays * MS_PER_DAY) {
    // Not due — pure no-op; the run is unchanged, so no write.
    return run;
  }

  // DUE: render the step into a Draft and QUEUE it through the gate (-> pending). The Executor
  // is the durable-wait seam; with DirectExecutor this is an in-process `drafts.save(draft)`.
  const nowIso = now.toISOString();
  const vars: Record<string, string> = {
    accountRef: run.accountRef,
    stepOrder: String(step.order),
    sequenceName: sequence.name,
    sequenceId: sequence.id,
  };
  const draft = Draft.parse({
    id: newId("dr"),
    kind: step.draftKind,
    refId: run.accountRef,
    subject:
      step.subjectTemplate === undefined ? undefined : renderTemplate(step.subjectTemplate, vars),
    body: renderTemplate(step.bodyTemplate, vars),
    channel: step.channel,
    // The draft is authored BY the sequence but is still `pending` — a human approves it. This
    // label is provenance only; it grants no send authority.
    createdBy: `sequence:${sequence.id}`,
    createdAt: nowIso,
    status: "pending",
  });

  const saved = await deps.executor.run(
    `sequence-step:${run.sequenceId}:${run.id}:${run.currentStep}`,
    draft,
    (d) => deps.drafts.save(d),
  );

  const nextStep = run.currentStep + 1;
  return deps.store.saveRun(
    SequenceRun.parse({
      ...run,
      currentStep: nextStep,
      lastStepAt: nowIso,
      queuedDraftIds: [...run.queuedDraftIds, saved.id],
      status: nextStep >= steps.length ? "completed" : "active",
    }),
  );
}
