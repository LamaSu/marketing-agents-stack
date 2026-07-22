/**
 * hatchet-executor.ts — the opt-in durable engine behind the `Executor` seam
 * (research/10-sota-integration-design.md §2.7). Adopts **Hatchet** (MIT, Postgres-native
 * durable execution — `@hatchet-dev/typescript-sdk`, verified MIT @ 1.26.x) as the production
 * engine that wraps this package's step functions with retry / scheduling / crash-resume.
 *
 * WHY A LOCAL STRUCTURAL SEAM INSTEAD OF IMPORTING THE SDK AT THE TOP LEVEL:
 * `@hatchet-dev/typescript-sdk` is a heavyweight gRPC/proto client (nice-grpc, protobufjs,
 * axios). Statically importing it from a file that `index.ts` re-exports would drag that whole
 * client into the OFFLINE demo path — which imports `@mstack/runtime` but only ever uses
 * `DirectExecutor`. So instead:
 *   - `HatchetLike` / `HatchetTaskHandle` / `HatchetWorkerHandle` below are a MINIMAL structural
 *     description of exactly the SDK surface we use. `HatchetExecutor` and
 *     `registerRuntimeWorkflows` are written against these — no SDK import, trivially mockable.
 *   - `createHatchetExecutor()` is the ONE place the real SDK is loaded, via a DYNAMIC
 *     `import(...)`, so it is pulled in only when a deployer explicitly opts into Hatchet. The
 *     demo never reaches it → needs neither the SDK, Postgres, nor a Hatchet server.
 *
 * PRESERVED — edge #3 / guardrail #2: `dispatchDraft` stays the single send path. Hatchet only
 * WRAPS the step functions (`runContentReview` / `runAccountActivation` / `approveAndDispatch`)
 * as tasks; it never replaces the gated, hash-chain-verified dispatch. Hatchet delivers tasks
 * AT LEAST ONCE (a crash mid-run, or a retry after a transient failure, re-runs the task) — the
 * reason that is SAFE here is that these steps are idempotent against the system of record:
 * `DraftStore#approve` and `dispatchDraft` both refuse a draft already in `status:'dispatched'`,
 * so a re-delivered `approveAndDispatch` / `dispatchDraft` cannot double-send. Crash-resume and
 * at-least-once retries are validated for real only when a deployer runs Hatchet + Postgres (see
 * README); the offline tests assert the idempotency that makes them safe.
 */
import type { Outcome, OutreachChannel } from "@mstack/core";
import type { ActivateAccount, ReviewRequest } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import { runContentReview } from "./workflows/content-review.js";
import type { ContentReviewResult, ReviewFn } from "./workflows/content-review.js";
import { runAccountActivation } from "./workflows/account-activation.js";
import type { AccountActivationResult, ActivateFn } from "./workflows/account-activation.js";
import { approveAndDispatch } from "./approve-and-dispatch.js";
import type { DraftStore } from "./draft-store.js";
import { DirectExecutor } from "./executor.js";
import type { Executor } from "./executor.js";

/* ─────────────────── the SDK surface we depend on (structural) ─────────────────── */

/**
 * Hatchet passes a run-context object (workflowRunId, taskRunId, logger, cancellation, …) as the
 * second argument to a task's `fn`. This package's step functions don't use it — their deps are
 * closed over at registration — so it stays opaque and optional here.
 */
export type HatchetRunContext = Readonly<Record<string, unknown>>;

/** A Hatchet task's body: `(input, ctx?) => Promise<output>`. Our task bodies just call the
 *  underlying step function; `ctx` is accepted (to match the SDK) and ignored. */
export type HatchetTaskFn<I, O> = (input: I, ctx?: HatchetRunContext) => Promise<O>;

/** Config passed to `hatchet.task({...})` (the fields this package sets). */
export interface HatchetTaskConfig<I, O> {
  name: string;
  fn: HatchetTaskFn<I, O>;
  /** per-task retry attempts; left to Hatchet's default when unset. */
  retries?: number;
}

/** The handle `hatchet.task(...)` returns — the only method we call on it is `.run(input)`
 *  (the SDK also offers `.runNoWait` / `.schedule`, which this package does not use). */
export interface HatchetTaskHandle<I, O> {
  run(input: I): Promise<O>;
}

/** A task handle with its I/O types erased, for the heterogeneous worker `workflows` list.
 *  `never` input / `unknown` output makes any concrete `HatchetTaskHandle<I, O>` assignable. */
export type ErasedHatchetTask = HatchetTaskHandle<never, unknown>;

/** The handle `hatchet.worker(...)` returns. */
export interface HatchetWorkerHandle {
  start(): Promise<void>;
}

/** Options passed to `hatchet.worker(name, { workflows })` (the subset we set). */
export interface HatchetWorkerOpts {
  workflows: ReadonlyArray<ErasedHatchetTask>;
}

/**
 * The minimal Hatchet client surface this package uses. The real `HatchetClient` (from
 * `HatchetClient.init()`) satisfies this structurally; `createHatchetExecutor` adapts it. Tests
 * pass a mock.
 */
export interface HatchetLike {
  task<I, O>(config: HatchetTaskConfig<I, O>): HatchetTaskHandle<I, O>;
  worker(name: string, opts: HatchetWorkerOpts): Promise<HatchetWorkerHandle>;
}

/* ─────────────────────────────── the executor ─────────────────────────────── */

export interface HatchetExecutorOpts {
  /** Default retry attempts applied to tasks this executor lazily declares. Hatchet's own
   *  default is used when unset. */
  retries?: number;
}

/**
 * The opt-in durable `Executor`. `run(name, input, step)` declares a Hatchet task named `name`
 * whose body is `step` the first time a given name is seen, caches that handle, and triggers a
 * run — so Hatchet owns retry/backoff/scheduling and crash-resume around it. Repeated runs of the
 * same `name` reuse the one task (one task, many runs), which is exactly what lets a durable
 * engine track which runs of a batch already completed.
 *
 * Constructed with any `HatchetLike` client — the real one via `createHatchetExecutor()`, a mock
 * in tests. Holds no send capability of its own: the wrapped steps still reach the single gated
 * `dispatchDraft`.
 */
export class HatchetExecutor implements Executor {
  readonly #hatchet: HatchetLike;
  readonly #opts: HatchetExecutorOpts;
  readonly #tasks = new Map<string, ErasedHatchetTask>();

  constructor(hatchet: HatchetLike, opts: HatchetExecutorOpts = {}) {
    this.#hatchet = hatchet;
    this.#opts = opts;
  }

  run<I, O>(name: string, input: I, step: (input: I) => Promise<O>): Promise<O> {
    return this.#ensureTask(name, step).run(input);
  }

  /** The underlying client, so a deployer can also register the product workflows for a worker
   *  (see `registerRuntimeWorkflows`) against the SAME client this executor triggers against. */
  get client(): HatchetLike {
    return this.#hatchet;
  }

  #ensureTask<I, O>(name: string, step: (input: I) => Promise<O>): HatchetTaskHandle<I, O> {
    const cached = this.#tasks.get(name);
    if (cached) return cached as unknown as HatchetTaskHandle<I, O>;

    const created = this.#hatchet.task<I, O>({
      name,
      retries: this.#opts.retries,
      // The task body IS the step function. `ctx` is accepted (SDK shape) and ignored — the
      // step's deps are already bound in the closure the caller passed.
      fn: (input) => step(input),
    });
    this.#tasks.set(name, created as unknown as ErasedHatchetTask);
    return created;
  }
}

/* ─────────────── registering the three product workflows as Hatchet tasks ─────────────── */

/** Stable task names for the three registered workflows (they double as the trigger names a
 *  deployer's webhook/cron maps onto — see `chorus-adapter.ts` for the same names on chorus). */
export const RUNTIME_WORKFLOW_NAMES = {
  contentReview: "content-review",
  accountActivation: "account-activation",
  approveAndDispatch: "approve-and-dispatch",
} as const;

/** Everything the three workflow bodies close over. Same shape the direct callers already pass
 *  to `runContentReview` / `runAccountActivation` / `approveAndDispatch`. */
export interface RuntimeWorkflowDeps {
  memory: MemoryRepo;
  draftStore: DraftStore;
  reviewFn: ReviewFn;
  activateFn: ActivateFn;
  /** the ONE gated channel dispatch flows through — `dispatchDraft` still owns the send. */
  channel: OutreachChannel;
}

/** Input to the `approve-and-dispatch` task (the human decision, applied outside the pre-approval
 *  retry loop — the UI still calls `DraftStore#approve` directly; this task is the on-approve
 *  dispatch step). */
export interface ApproveAndDispatchInput {
  draftId: string;
  actor: string;
}

/** The three registered task handles plus a helper to serve them on a worker. */
export interface RuntimeWorkflowTasks {
  contentReview: HatchetTaskHandle<ReviewRequest, ContentReviewResult>;
  accountActivation: HatchetTaskHandle<ActivateAccount, AccountActivationResult>;
  approveAndDispatch: HatchetTaskHandle<ApproveAndDispatchInput, Outcome>;
  /**
   * Build + start a Hatchet worker serving all three tasks. Opt-in — needs a running Hatchet +
   * Postgres; the offline demo never calls it.
   */
  startWorker(name?: string): Promise<HatchetWorkerHandle>;
}

/**
 * Register `runContentReview` / `runAccountActivation` / `approveAndDispatch` as Hatchet tasks.
 * Each task's body IS the corresponding step function with `deps` closed over — so the durable
 * engine runs exactly the same logic the direct path runs, and the only send remains the gated
 * `dispatchDraft` inside `approveAndDispatch`.
 *
 * A deployer calls this once at worker startup and then `startWorker()`; triggers (webhook / cron
 * / manual) map onto `.run(input)` / `.runNoWait(input)` on the returned handles. The HITL
 * approval step is deliberately NOT a task here — it stays human-owned outside the retry loop
 * (the portal/console UI calls `DraftStore#approve` / `#reject` directly), exactly as today.
 */
export function registerRuntimeWorkflows(
  hatchet: HatchetLike,
  deps: RuntimeWorkflowDeps,
): RuntimeWorkflowTasks {
  const { memory, draftStore, reviewFn, activateFn, channel } = deps;

  const contentReview = hatchet.task<ReviewRequest, ContentReviewResult>({
    name: RUNTIME_WORKFLOW_NAMES.contentReview,
    fn: (req) => runContentReview(req, { memory, draftStore, reviewFn }),
  });

  const accountActivation = hatchet.task<ActivateAccount, AccountActivationResult>({
    name: RUNTIME_WORKFLOW_NAMES.accountActivation,
    fn: (input) => runAccountActivation(input, { memory, draftStore, activateFn }),
  });

  const approveAndDispatchTask = hatchet.task<ApproveAndDispatchInput, Outcome>({
    name: RUNTIME_WORKFLOW_NAMES.approveAndDispatch,
    fn: ({ draftId, actor }) => approveAndDispatch(draftId, actor, channel, { memory, draftStore }),
  });

  return {
    contentReview,
    accountActivation,
    approveAndDispatch: approveAndDispatchTask,
    startWorker: async (name = "mstack-runtime") => {
      const worker = await hatchet.worker(name, {
        workflows: [contentReview, accountActivation, approveAndDispatchTask],
      });
      await worker.start();
      return worker;
    },
  };
}

/* ───────────────────── opt-in: build an executor on the real SDK ───────────────────── */

export interface CreateHatchetExecutorOpts extends HatchetExecutorOpts {
  /** Passed straight to `HatchetClient.init(config)` (token/host/tls/etc.). When unset, the SDK
   *  reads its usual env config (`HATCHET_CLIENT_TOKEN`, …). */
  config?: unknown;
}

/**
 * Construct a `HatchetExecutor` backed by a REAL `@hatchet-dev/typescript-sdk` client. Loads the
 * SDK via a DYNAMIC import, so the heavyweight gRPC client is pulled in ONLY when a deployer opts
 * into Hatchet here — importing `@mstack/runtime` for the offline `DirectExecutor` path never
 * triggers it, keeping the keyless demo free of the SDK / Postgres / a Hatchet server.
 *
 * ASSUMPTION (verified against the @hatchet-dev/typescript-sdk V1 docs; re-verify against your
 * installed 1.26.x): the client is created via `HatchetClient.init()` and exposes
 * `.task({ name, fn, retries })` → handle with `.run(input)`, and `.worker(name, { workflows })`
 * → `Promise<Worker>` with `.start()`. These are the only surfaces used; if a name differs in
 * your version, adapt this one function — the `Executor` seam, `registerRuntimeWorkflows`, and
 * every test are unaffected.
 */
export async function createHatchetExecutor(
  opts: CreateHatchetExecutorOpts = {},
): Promise<HatchetExecutor> {
  const mod = (await import("@hatchet-dev/typescript-sdk")) as unknown as {
    HatchetClient: { init(config?: unknown): HatchetLike };
  };
  const client = mod.HatchetClient.init(opts.config);
  return new HatchetExecutor(client, { retries: opts.retries });
}

/** Convenience for callers that want the offline default without importing `executor.js`
 *  separately: the direct, in-process executor `mstack demo` runs on. */
export function defaultExecutor(): Executor {
  return new DirectExecutor();
}
