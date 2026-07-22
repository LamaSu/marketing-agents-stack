# @mstack/runtime

The connective runtime: the draft-first dispatch gate plus the two HITL workflows that wire
`@mstack/reviewer` and `@mstack/account-intel` into the signal → decision → action loop
(`research/06-architecture.md` §3.3, §4). This is where **guardrail #2 — a human approves
every send — becomes a state machine instead of a convention** (`docs/build-conventions.md`).

## Guardrail #2, made mechanical

`src/dispatch.ts#dispatchDraft` is the **only** function in this package — and the only one
in the whole repo — allowed to call `OutreachChannel.dispatch`. Before it touches a channel it
asserts, in order:

1. an `Approval` was actually supplied,
2. `approval.decision === "approve"`,
3. `approval.draftId === draft.id`,
4. `draft.status === "approved"`.

Any failure throws before the channel is ever called. On success it dispatches, marks the
draft `dispatched` in `@mstack/memory`, and persists + returns the canonical `Outcome` row.
Every `OutreachChannel` implementation in `src/channels.ts` re-asserts the same check
defensively (the seam contract in `@mstack/core` requires it), but re-asserting is a guard,
not a second send path — `dispatch.test.ts` grep-scans this package's production source and
asserts there is exactly one `*.dispatch(` **call site**, in `dispatch.ts`.

The only way to reach `dispatchDraft` with an `approved` draft at all is
`src/approve-and-dispatch.ts#approveAndDispatch` — `approve → getDraft → dispatchDraft` — and
that in turn only works on a draft `src/draft-store.ts#DraftStore.save()` put there, which
always forces `status:'pending'` regardless of what its caller passed in. Nothing upstream of
a human decision can ever produce a draft this package will send.

`DraftStore#approve`/`#reject` additionally refuse to act on a draft that is already
`status:'dispatched'` — without that check, re-approving an already-sent draft would flip its
status back to `'approved'` and a retried `approveAndDispatch` would dispatch it a second time.
`'dispatched'` is a terminal state; every other transition (including approving after an
earlier rejection, or retrying an approve that didn't reach dispatch) stays allowed.

## Durable execution — the `Executor` seam (Hatchet, opt-in)

The two workflows and `approveAndDispatch` are plain `async` functions: input in, result out.
*Where* they run is a swap behind one small seam (`src/executor.ts`):

```ts
interface Executor {
  run<I, O>(name: string, input: I, step: (input: I) => Promise<O>): Promise<O>;
}
```

- **`DirectExecutor` (the default).** `run(name, input, step)` is exactly `step(input)` — in-process,
  no scheduling, no persistence, no network. It is behavior-identical to calling the workflow
  function directly, which is what `mstack demo` does, so **the keyless demo needs no Postgres and
  no Hatchet.** This is the offline path, and it stays the default.
- **`HatchetExecutor` (opt-in).** Adopts [Hatchet](https://github.com/hatchet-dev/hatchet) (MIT,
  Postgres-native durable execution — `@hatchet-dev/typescript-sdk`) as the production engine.
  `registerRuntimeWorkflows(hatchet, deps)` registers `runContentReview` / `runAccountActivation` /
  `approveAndDispatch` as Hatchet tasks (each task's body *is* the step function), and
  `HatchetExecutor.run(...)` triggers them. Hatchet then owns retry / backoff / scheduling and —
  the point — **crash-resume**: a nightly 10k-account batch that dies at account 7,000 resumes
  from the last completed account instead of redoing everything. Triggers (webhook / cron / manual)
  map onto Hatchet's; the HITL approval step stays human-owned *outside* the retry loop (the UI
  still calls `DraftStore#approve` directly).

Hatchet **wraps** the step functions; it does **not** replace the send path. `dispatchDraft`
(below) remains the single, gated, hash-chain-verified way a `Draft` reaches `dispatched` —
adopting a durable engine adds no new way to send.

The SDK is a heavyweight gRPC client, so it is never imported on the offline path: the executor is
written against a small structural interface (`HatchetLike`), and `createHatchetExecutor()` loads
the real SDK lazily via a dynamic `import(...)`. A deployer's opt-in worker entrypoint looks like:

```ts
import { openMemory } from "@mstack/memory";
import {
  DraftStore, LocalOutreachChannel, createHatchetExecutor, registerRuntimeWorkflows,
} from "@mstack/runtime";

const executor = await createHatchetExecutor();        // loads @hatchet-dev/typescript-sdk here only
const memory = await openMemory();
const deps = { memory, draftStore: new DraftStore(memory), reviewFn, activateFn,
               channel: new LocalOutreachChannel() };
const wf = registerRuntimeWorkflows(executor.client, deps);
await wf.startWorker();                                 // serves all three tasks (needs Hatchet + Postgres)
```

**At-least-once + crash-resume is safe here because the steps are idempotent against the system of
record.** `DraftStore#approve` and `dispatchDraft` both refuse a draft already in
`status:'dispatched'`, so a re-delivered `approveAndDispatch` / `dispatchDraft` (a retry, or a run
re-executed after a crash) cannot double-send. The offline tests (`executor.test.ts`) assert exactly
this idempotency with a mock Hatchet client; the **real crash-resume behaviour is validated only
when a deployer runs Hatchet + Postgres** — there is no Hatchet server or Postgres in CI, by design.

## Pieces

| File | Produces |
|---|---|
| `dispatch.ts` | `dispatchDraft` — the one send path; `assertApproved` — the shared guard |
| `draft-store.ts` | `DraftStore` — `save` (always pending) / `listPending` / `approve` / `reject` |
| `channels.ts` | `LocalOutreachChannel` (offline, writes `outbox/`), `GatecraftEmailChannel` (documented stub) |
| `approve-and-dispatch.ts` | `approveAndDispatch`, `rejectDraft` — the human-gated completion |
| `workflows/content-review.ts` | `runContentReview` — reviewFn → persist Review → 2 pending drafts |
| `workflows/account-activation.ts` | `runAccountActivation` — activateFn → persist Decision → 1 pending draft |
| `executor.ts` | `Executor` seam + `DirectExecutor` (the offline default `mstack demo` runs on) |
| `hatchet-executor.ts` | `HatchetExecutor` + `registerRuntimeWorkflows` + `createHatchetExecutor` — opt-in Hatchet durable engine |
| `chorus-adapter.ts` | documentation-only note on how the above register as chorus/Hatchet steps |

Both workflow functions take their agent pipeline **injected** (`reviewFn` / `activateFn`) —
this package does not depend on `@mstack/reviewer` or `@mstack/account-intel`, so it stays
agnostic to whether the real Claude-backed pipeline or a deterministic offline fake is
running underneath. See each workflow file's header for the exact injected shape, and
`chorus-adapter.ts` for a wiring wrinkle worth knowing about (`@mstack/account-intel`'s
`activateAccount` already self-persists and returns a smaller brief type than this package's
`activateFn` contract expects — adapting one to the other is a live-wiring concern, not
something this package resolves).

## Example — offline, end to end

```ts
import { openMemory } from "@mstack/memory";
import {
  DraftStore,
  LocalOutreachChannel,
  runContentReview,
  approveAndDispatch,
} from "@mstack/runtime";

const memory = await openMemory(":memory:");
const draftStore = new DraftStore(memory, "./drafts");
const channel = new LocalOutreachChannel("./outbox");

const { drafts } = await runContentReview(reviewRequest, {
  memory,
  draftStore,
  reviewFn: myReviewerAdapter, // live: wraps @mstack/reviewer; offline: a canned fake
});
// drafts.partnerEmail.status === "pending" — nothing sent yet.

// ... a human looks at drafts/<id>.json and decides to approve ...
const outcome = await approveAndDispatch(drafts.partnerEmail.id, "human@example.com", channel, {
  memory,
  draftStore,
});
// outcome.result === "sent"; outbox/<id>.json now exists; memory.verifyAuditChain() === true.
```

## Config

- `DRAFTS_DIR` env (default `./drafts`) — where `DraftStore` writes the human-facing
  `<id>.json` sidecar for every draft, in addition to persisting to `@mstack/memory`.
- `OUTBOX_DIR` env (default `./outbox`) — where `LocalOutreachChannel` "sends" to (a file, not
  a network call).

## Known simplification

`GatecraftEmailChannel` is a documented stub, not a working ESP integration: it shows the
`broker.proxyCall`-based shape a real send would take but throws if constructed without a
`sendUrl`, since no transactional-email provider is registered yet
(`@mstack/credentials`' `registry.ts`). Wiring a real one is a future connector task.
