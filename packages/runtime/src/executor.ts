/**
 * executor.ts — the durable-execution SEAM (research/10-sota-integration-design.md §2.7).
 *
 * The two product workflows (`runContentReview`, `runAccountActivation`) and the human-gated
 * completion (`approveAndDispatch`) are plain `async` functions: input in, result out. WHERE
 * they run — directly in this process, or wrapped by a durable engine that gives them
 * retries / scheduling / crash-resume — is a swap behind this one small interface. Both
 * executors call the SAME step function; nothing about the workflow logic changes.
 *
 * This is the same move the rest of the stack makes with its five adapter seams
 * (`@mstack/core`'s `seams.ts`): an injectable boundary whose OFFLINE default is the plain
 * in-process path, with an opt-in production impl behind it.
 *
 *   - `DirectExecutor` (DEFAULT, this file): runs the step in-process, exactly as calling the
 *     function directly. No Postgres, no Hatchet, no network. This is what `mstack demo` uses,
 *     so the keyless demo needs nothing external.
 *   - `HatchetExecutor` (opt-in, `hatchet-executor.ts`): registers the step as a Hatchet task so
 *     Hatchet owns retry/backoff/scheduling and — the point — CRASH-RESUME (a nightly batch
 *     that dies part-way resumes from the last completed run instead of redoing everything).
 *
 * PRESERVED — edge #3 / guardrail #2: neither executor is a send path. `dispatchDraft` (in
 * `dispatch.ts`) remains the one and only place an `OutreachChannel.dispatch` is called; an
 * executor merely WRAPS the step functions that eventually reach it. Wrapping a step in a
 * durable engine adds no new way to send — the send still goes through the same gated,
 * hash-chain-verified path.
 */

/**
 * The durable-execution seam. `run` takes a stable task `name`, the `input`, and the `step`
 * function to execute — and returns the step's result. Implementations decide what "run" means:
 * call it in-process (`DirectExecutor`), or hand it to a durable engine (`HatchetExecutor`).
 *
 * The `name` is a stable identifier for the unit of work (e.g. `"account-activation"`). A
 * durable engine uses it to register/track the task; the direct executor ignores it. Passing the
 * same `name` for every run of the same logical workflow is what lets a durable engine treat
 * many runs as instances of one task (and, on crash, know which already completed).
 */
export interface Executor {
  run<I, O>(name: string, input: I, step: (input: I) => Promise<O>): Promise<O>;
}

/**
 * The offline default: run the step in-process, right now. `run(name, input, step)` is exactly
 * `step(input)` — a transparent pass-through that adds no scheduling, no persistence, and no
 * external dependency. It is behavior-identical to calling the workflow function directly, which
 * is what every current caller (and `mstack demo`) already does; routing through it just makes
 * the seam explicit so a deployer can swap in `HatchetExecutor` without touching call sites.
 *
 * Because it holds no state and touches nothing external, a single `DirectExecutor` is safe to
 * share across a whole process (the CLI constructs one per `mstack demo` run).
 */
export class DirectExecutor implements Executor {
  run<I, O>(_name: string, input: I, step: (input: I) => Promise<O>): Promise<O> {
    return step(input);
  }
}
