# @mstack/sequences

A multi-step **sequence / cadence engine** — the core capability of Outreach and Salesloft —
built as an orchestration on top of this stack's existing draft-first gate.

## The one invariant: a sequence NEVER auto-sends

This is both the parity feature **and** the differentiator.

Outreach/Salesloft cadences **auto-send** on a schedule. This engine does not. Every step of a
cadence produces a `Draft` that lands **`pending`** in the existing draft-first gate
(`@mstack/runtime`'s `DraftStore#save`, which force-sets `status:'pending'` regardless of what
the caller passes). A human still approves every send, and `dispatchDraft` — the single,
hash-chain-verified send path in the whole repo (guardrail #2) — remains the only way a draft
ever becomes `dispatched`.

> A cadence here is an **orchestration that queues drafts over time**. It cannot bypass
> `DraftStore#approve` or the signed, append-only `Approval` audit chain. It queues; the human
> approves; only then does `dispatchDraft` send.

```
sequence step is due
        │
        ▼
  render templates ──▶ Draft ──▶ DraftStore#save ──▶ status:'pending'  ◀── engine stops here
                                                          │
                                             (a human reviews the queue)
                                                          │
                                              DraftStore#approve  ──▶ hash-chained Approval
                                                          │
                                                   dispatchDraft   ──▶ the ONE send path
```

The engine reaches only as far as the dashed line. It never calls a channel, never calls
`dispatchDraft`, and never writes an `Approval`. A static test (`sequences.test.ts`) grep-scans
this package's production source and fails if any send/approval call site ever appears.

## Primitives

- **`Sequence`** `{ id, name, steps }` — a reusable cadence template.
- **`SequenceStep`** `{ order, channel, draftKind, subjectTemplate?, bodyTemplate, delayDays, stopIfReplied }`
  — one rung. `delayDays` is the wait before this step fires (measured from the previous step),
  so step 0 typically has `delayDays: 0`. Templates use `{{var}}` substitution.
- **`SequenceRun`** `{ id, sequenceId, accountRef, currentStep, status, startedAt, lastStepAt, queuedDraftIds }`
  — one account's live enrollment. `status` is `active` | `stopped` | `completed`.
  `queuedDraftIds` is bookkeeping so reply-detection can join the run's own drafts to their
  `Outcome`s (an `Outcome` references a draft id, not an account).

## The runner

`advanceSequence(run, sequence, deps)` moves one run forward by **at most one step**:

- run not `active` → returned unchanged (terminal).
- current step honors replies **and** a `replied`/`meeting` `Outcome` exists for the run's
  queued drafts → run becomes `stopped` (before queuing anything).
- current step's `delayDays` **not yet elapsed** since `lastStepAt` → no-op.
- otherwise → render the step into a `Draft` and **queue it pending** via `DraftStore#save`,
  advance `currentStep`, and mark `completed` when the last step is queued.

Call it on a schedule (a cron, a nightly batch, a Hatchet task) — each call queues at most one
draft into the human's pending queue.

### Deps (all injectable — the whole engine runs offline)

```ts
interface AdvanceDeps {
  memory: MemoryRepo;      // read Outcomes for reply-detection
  drafts: DraftStore;      // the draft-first gate — the only exit for a step
  store: SequenceStore;    // persists the run after each advance
  executor: Executor;      // durable-wait seam; DirectExecutor is the offline default
  now?: () => Date;        // injectable clock (tests)
  hasReplied?: (run, memory) => Promise<boolean>; // default queries queued drafts' Outcomes
}
```

The `Executor` seam is why the wait/schedule is pluggable: `DirectExecutor` (the offline
default) runs the queue step in-process with no network; an opt-in `HatchetExecutor` can make
the cadence durable (crash-resume). Neither is a send path — wrapping a step in a durable
engine adds no new way to send.

## Offline example

```ts
import { openMemory } from "@mstack/memory";
import { DraftStore, DirectExecutor } from "@mstack/runtime";
import {
  exampleSequence,
  openSequenceStore,
  startSequenceRun,
  advanceSequence,
} from "@mstack/sequences";

const memory = await openMemory(":memory:");        // or a real .duckdb file
const store = await openSequenceStore(memory);
const drafts = new DraftStore(memory);
const executor = new DirectExecutor();

const seq = exampleSequence();                       // 2-step: opener (day 0) + follow-up (day 3)
await store.saveSequence(seq);

let run = startSequenceRun(seq, "acme.com");
await store.saveRun(run);

// Call this on your schedule. Each due step queues ONE pending draft.
run = await advanceSequence(run, seq, { memory, drafts, store, executor });

const pending = await drafts.listPending();          // ← the human's approval queue
// ...a human calls drafts.approve(id, actor), then dispatchDraft sends. Never the cadence.
```

## Persistence

`SequenceStore` adds two tables (`sequences`, `sequence_runs`) through `MemoryRepo`'s public
generic `query()` — it does **not** modify `@mstack/memory`'s `memory-repo.ts`. Storage follows
the warehouse convention (full validated object as a JSON `data` column plus a few indexed
columns). `init()` is idempotent (`CREATE TABLE IF NOT EXISTS`).

## What this package deliberately does NOT do

- It does not send. No channel call, no `dispatchDraft`.
- It does not approve. No `Approval` is written by the engine.
- It does not modify `@mstack/core`, `@mstack/runtime`, `@mstack/memory`, or the demo.

Those boundaries are enforced by the static guardrail test, not just documented here.
