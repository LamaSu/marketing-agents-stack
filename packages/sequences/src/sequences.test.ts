import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Outcome, newId } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import { DraftStore, DirectExecutor } from "@mstack/runtime";

import { advanceSequence, startSequenceRun } from "./runner.js";
import type { AdvanceDeps } from "./runner.js";
import { openSequenceStore, SequenceStore } from "./store.js";
import { exampleSequence } from "./example.js";
import { renderTemplate } from "./render.js";
import type { Sequence } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY0 = new Date("2026-07-20T00:00:00.000Z");
function plusDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * MS_PER_DAY);
}

describe("@mstack/sequences — cadence engine (queues pending Drafts, never sends)", () => {
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
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-sequences-drafts-"));
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

  it("queues step-1 as a PENDING Draft (into the draft-first gate), not a send", async () => {
    let run = startSequenceRun(seq, "acme.com", { now: () => clock });
    await seqStore.saveRun(run);

    run = await advanceSequence(run, seq, deps);

    // exactly one draft queued; the run moved to the next step and is still active.
    expect(run.currentStep).toBe(1);
    expect(run.status).toBe("active");
    expect(run.queuedDraftIds).toHaveLength(1);

    const draftId = run.queuedDraftIds[0];
    expect(draftId).toBeTruthy();
    const draft = await memory.getDraft(String(draftId));
    // THE INVARIANT: the queued draft is PENDING, awaiting a human — never auto-sent.
    expect(draft?.status).toBe("pending");
    expect(draft?.refId).toBe("acme.com");
    expect(draft?.kind).toBe("outreach_email");
    // template rendered with the account ref.
    expect(draft?.body).toContain("acme.com");
    expect(draft?.subject).toContain("acme.com");
    // it shows up in the human's pending queue.
    const pending = await draftStore.listPending();
    expect(pending.map((d) => d.id)).toEqual([String(draftId)]);
  });

  it("does NOT queue step-2 until its delay elapses, then queues it and completes", async () => {
    let run = startSequenceRun(seq, "acme.com", { now: () => clock });
    await seqStore.saveRun(run);

    // day 0: step-1 (delayDays 0) queues.
    run = await advanceSequence(run, seq, deps);
    expect(run.currentStep).toBe(1);
    expect(run.queuedDraftIds).toHaveLength(1);

    // still day 0: step-2 (delayDays 3) is NOT due — pure no-op, nothing new queued.
    run = await advanceSequence(run, seq, deps);
    expect(run.currentStep).toBe(1);
    expect(run.queuedDraftIds).toHaveLength(1);
    expect(await draftStore.listPending()).toHaveLength(1);

    // day 3: step-2 is due — queues and the run completes (last step reached).
    clock = plusDays(DAY0, 3);
    run = await advanceSequence(run, seq, deps);
    expect(run.currentStep).toBe(2);
    expect(run.status).toBe("completed");
    expect(run.queuedDraftIds).toHaveLength(2);

    // both drafts sit PENDING — the cadence queued them, it did not send either.
    const pending = await draftStore.listPending();
    expect(pending).toHaveLength(2);
    for (const d of pending) expect(d.status).toBe("pending");
  });

  it("stops the run on a recorded reply (stopIfReplied) BEFORE queuing step-2", async () => {
    let run = startSequenceRun(seq, "acme.com", { now: () => clock });
    await seqStore.saveRun(run);

    // day 0: step-1 queues its draft.
    run = await advanceSequence(run, seq, deps);
    expect(run.currentStep).toBe(1);
    const firstDraftId = String(run.queuedDraftIds[0]);

    // the prospect replies — recorded as an Outcome against that draft (as e.g. an inbound
    // ingest would). This is the same closed-loop Outcome the rest of the stack records.
    await memory.putOutcome(
      Outcome.parse({
        id: newId("out"),
        refType: "draft",
        refId: firstDraftId,
        result: "replied",
        ts: "2026-07-21T09:00:00.000Z",
      }),
    );

    // day 3: step-2 WOULD be due — but the reply stops the run first.
    clock = plusDays(DAY0, 3);
    run = await advanceSequence(run, seq, deps);
    expect(run.status).toBe("stopped");
    expect(run.currentStep).toBe(1); // never advanced past the replied-to step
    expect(run.queuedDraftIds).toHaveLength(1); // step-2 draft was never created

    // a stopped run is terminal — advancing again is a no-op.
    run = await advanceSequence(run, seq, deps);
    expect(run.status).toBe("stopped");
    expect(await draftStore.listPending()).toHaveLength(1);
  });

  it("GUARDRAIL (runtime): running a full cadence writes ZERO approvals, ZERO sends — only pending drafts", async () => {
    let run = startSequenceRun(seq, "acme.com", { now: () => clock });
    await seqStore.saveRun(run);

    run = await advanceSequence(run, seq, deps); // step-1
    clock = plusDays(DAY0, 3);
    run = await advanceSequence(run, seq, deps); // step-2 -> completed
    expect(run.status).toBe("completed");

    // NO Approval was written by the runner (a human hasn't approved anything yet).
    const approvalRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM approvals",
    );
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
    // the audit chain is trivially intact (empty), never touched by the cadence.
    expect(await memory.verifyAuditChain()).toBe(true);

    // NO draft was dispatched, and NO "sent" Outcome exists — nothing left the gate.
    const dispatchedRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM drafts WHERE status = $status",
      { status: "dispatched" },
    );
    expect(Number(dispatchedRows[0]?.c ?? -1)).toBe(0);
    const sentRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_type = 'draft'",
    );
    expect(Number(sentRows[0]?.c ?? -1)).toBe(0);

    // every draft the cadence produced is still pending, awaiting a human.
    for (const id of run.queuedDraftIds) {
      expect((await memory.getDraft(id))?.status).toBe("pending");
    }
  });

  it("run persistence round-trips through the SequenceStore", async () => {
    let run = startSequenceRun(seq, "acme.com", { now: () => clock });
    await seqStore.saveRun(run);
    run = await advanceSequence(run, seq, deps);

    const reloaded = await seqStore.getRun(run.id);
    expect(reloaded?.currentStep).toBe(1);
    expect(reloaded?.status).toBe("active");
    expect(reloaded?.queuedDraftIds).toEqual(run.queuedDraftIds);

    const active = await seqStore.listRuns({ status: "active", accountRef: "acme.com" });
    expect(active.map((r) => r.id)).toContain(run.id);
  });
});

describe("renderTemplate", () => {
  it("substitutes known {{vars}} and leaves unknown tokens visible", () => {
    expect(renderTemplate("Hi {{name}}", { name: "acme.com" })).toBe("Hi acme.com");
    expect(renderTemplate("Hi {{missing}}", {})).toBe("Hi {{missing}}");
    expect(renderTemplate("{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-2");
  });
});

describe("GUARDRAIL (static): the sequences engine has NO send / approval call sites", () => {
  // Mirrors dispatch.test.ts's source-scan. The runner must be structurally incapable of
  // sending or approving: it may only produce PENDING drafts via DraftStore#save. We strip
  // comments first (so doc-prose mentioning `dispatchDraft`/approve/etc. can't false-positive)
  // and then assert the production code contains none of the send/approval CALL forms.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  function collectProductionSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectProductionSourceFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
    { label: "<expr>.dispatch( — a channel send", re: /\.\s*dispatch\s*\(/g },
    { label: "dispatchDraft( — the one send path", re: /\bdispatchDraft\s*\(/g },
    { label: "<expr>.approve( — an approval mutation", re: /\.\s*approve\s*\(/g },
    { label: "<expr>.reject( — an approval mutation", re: /\.\s*reject\s*\(/g },
    { label: "appendApproval( — writes an Approval row", re: /\bappendApproval\s*\(/g },
  ];

  it("contains no send/approval call sites in any production source file", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const files = collectProductionSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    let usesGate = false;
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\.\s*save\s*\(/.test(code)) usesGate = true;
      for (const { label, re } of FORBIDDEN) {
        const matches = code.match(re);
        if (matches && matches.length > 0) {
          violations.push(`${file.replace(/\\/g, "/")}: ${matches.length}x ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // positive control: the engine really does route through the draft-first gate.
    expect(usesGate).toBe(true);
  });
});
