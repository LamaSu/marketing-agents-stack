/**
 * tick.test.ts — `tickSequences` advances EVERY active run by one step, offline, and reports a
 * per-run summary. Mirrors sequences.test.ts's in-memory setup (real MemoryRepo over :memory:,
 * DirectExecutor, injected clock). The invariant still holds through the batch path: every step
 * queues a PENDING draft, nothing is ever sent.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import { DraftStore, DirectExecutor } from "@mstack/runtime";

import { startSequenceRun } from "./runner.js";
import type { AdvanceDeps } from "./runner.js";
import { openSequenceStore, SequenceStore } from "./store.js";
import { exampleSequence } from "./example.js";
import { tickSequences } from "./tick.js";
import type { Sequence } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY0 = new Date("2026-07-20T00:00:00.000Z");

describe("tickSequences — advance all active runs (queue-only, never sends)", () => {
  let memory: MemoryRepo;
  let seqStore: SequenceStore;
  let draftStore: DraftStore;
  let draftsDir: string;
  let clock: Date;
  let seq: Sequence;
  let deps: AdvanceDeps;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    seqStore = await openSequenceStore(memory);
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-tick-drafts-"));
    draftStore = new DraftStore(memory, draftsDir);
    clock = DAY0;
    seq = exampleSequence();
    await seqStore.saveSequence(seq);
    deps = {
      memory,
      drafts: draftStore,
      store: seqStore,
      executor: new DirectExecutor(),
      now: () => clock,
    };
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
  });

  it("queues step-1 for every active run and reports each as 'queued'", async () => {
    for (const ref of ["acme.com", "globex.com"]) {
      await seqStore.saveRun(startSequenceRun(seq, ref, { now: () => clock }));
    }

    const result = await tickSequences(deps);

    expect(result.runsExamined).toBe(2);
    expect(result.advanced).toBe(2);
    expect(result.summaries).toHaveLength(2);
    for (const summary of result.summaries) {
      expect(summary.outcome).toBe("queued");
      expect(summary.currentStep).toBe(1);
      expect(summary.status).toBe("active");
      expect(summary.queuedDraftId).toBeTruthy();
      // THE INVARIANT: the queued draft is PENDING — the gate held, nothing was sent.
      const draft = await memory.getDraft(String(summary.queuedDraftId));
      expect(draft?.status).toBe("pending");
    }
    // both drafts sit in the human's pending queue; none dispatched.
    expect(await draftStore.listPending()).toHaveLength(2);
  });

  it("is a no-op when no step is due, then advances when the delay elapses", async () => {
    await seqStore.saveRun(startSequenceRun(seq, "acme.com", { now: () => clock }));

    // day 0: first tick queues step-1.
    const first = await tickSequences(deps);
    expect(first.advanced).toBe(1);
    expect(first.summaries[0]?.outcome).toBe("queued");

    // still day 0: step-2 (delayDays 3) not due -> no-op, advanced 0.
    const second = await tickSequences(deps);
    expect(second.runsExamined).toBe(1);
    expect(second.advanced).toBe(0);
    expect(second.summaries[0]?.outcome).toBe("no_op");

    // day 3: step-2 due -> queued, and the run completes (last step reached).
    clock = new Date(DAY0.getTime() + 3 * MS_PER_DAY);
    const third = await tickSequences(deps);
    expect(third.advanced).toBe(1);
    expect(third.summaries[0]?.outcome).toBe("queued");
    expect(third.summaries[0]?.status).toBe("completed");

    // a completed run is no longer active — nothing left to tick.
    const fourth = await tickSequences(deps);
    expect(fourth.runsExamined).toBe(0);
    expect(fourth.advanced).toBe(0);

    // both drafts the cadence produced are still PENDING — the gate held throughout.
    const pending = await draftStore.listPending();
    expect(pending).toHaveLength(2);
    for (const draft of pending) expect(draft.status).toBe("pending");
  });
});
