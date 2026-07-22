/**
 * wiring.test.ts — offline coverage for the four Wave-F operable commands wired into `mstack`:
 * ingest-outcomes, report, sequence (start/tick), train-qualifier. Same in-memory/temp-warehouse
 * setup as demo.test.ts (no ANTHROPIC_API_KEY -> offline; temp DATA_DIR/DRAFTS_DIR/OUTBOX_DIR).
 *
 * INVARIANT under test throughout: the new commands NEVER send. `sequence` queues PENDING drafts
 * into the existing gate; the outbox stays empty and no draft is dispatched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Outcome, newId } from "@mstack/core";
import { exampleSequence, openSequenceStore, startSequenceRun } from "@mstack/sequences";

import type { CliContext } from "./context.js";
import { openContext } from "./context.js";
import { runSeed } from "./seed.js";
import { runDemo } from "./demo.js";
import { runIngestOutcomes, runReport, runSequence, runTrainQualifier } from "./commands.js";

/** Count only real `.json` sends in the outbox dir (dir may not exist -> 0). */
async function outboxJsonCount(dir: string): Promise<number> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".json")).length;
}

/** Run `fn`, capturing everything it writes to console.log as one joined string. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("mstack Wave-F commands (offline)", () => {
  let dir: string;
  let ctx: CliContext;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY; // force offline mode
    dir = await mkdtemp(join(tmpdir(), "mstack-wiring-"));
    ctx = await openContext({
      mode: "offline",
      dataDir: join(dir, "data"),
      draftsDir: join(dir, "drafts"),
      outboxDir: join(dir, "outbox"),
      lanceDir: join(dir, "lance"),
    });
  });

  afterEach(async () => {
    await ctx.memory.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("ingest-outcomes populates the outcomes table", async () => {
    await runIngestOutcomes(ctx);
    const rows = await ctx.memory.query<{ c: number | bigint }>("SELECT COUNT(*) AS c FROM outcomes");
    expect(Number(rows[0]?.c ?? 0)).toBeGreaterThan(0);
  });

  it("report renders a non-empty GTM report after seed + ingest", async () => {
    await runSeed(ctx);
    await runIngestOutcomes(ctx);

    const text = await captureLog(() => runReport(ctx));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("GTM FUNNEL");
    expect(text).toContain("CONVERSION BY ACCOUNT TIER");
    expect(text).toContain("REVIEW OUTCOMES");
  });

  it("sequence start queues a PENDING draft and sends nothing (the gate holds)", async () => {
    await runSequence(ctx, "start", "acme.com");

    const pending = await ctx.draftStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.createdBy).toContain("sequence:");
    expect(pending[0]?.refId).toBe("acme.com");

    // NOTHING was sent — the cadence only queues into the human gate.
    expect(await outboxJsonCount(ctx.paths.outboxDir)).toBe(0);
    const dispatched = await ctx.memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) AS c FROM drafts WHERE status = 'dispatched'",
    );
    expect(Number(dispatched[0]?.c ?? -1)).toBe(0);
  });

  it("sequence tick advances an active run by queuing its due step (no send)", async () => {
    // Enroll a run at step 0 WITHOUT advancing, so tick has a due step-0 (delayDays 0) to queue.
    const store = await openSequenceStore(ctx.memory);
    const seq = exampleSequence();
    await store.saveSequence(seq);
    await store.saveRun(startSequenceRun(seq, "globex.com"));

    const pendingBefore = (await ctx.draftStore.listPending()).length;
    await runSequence(ctx, "tick");
    const pendingAfter = await ctx.draftStore.listPending();

    // tick queued step-0 as a PENDING draft and advanced the run to step 1.
    expect(pendingAfter.length).toBe(pendingBefore + 1);
    const runs = await store.listRuns({ accountRef: "globex.com" });
    expect(runs[0]?.currentStep).toBe(1);
    expect(runs[0]?.status).toBe("active");

    // still nothing sent.
    expect(await outboxJsonCount(ctx.paths.outboxDir)).toBe(0);
  });

  it("train-qualifier handles an empty-outcome warehouse without crashing", async () => {
    await expect(runTrainQualifier(ctx)).resolves.toBeUndefined();
  });

  it("train-qualifier fits on seeded data joined through a real outreach outcome", async () => {
    await runSeed(ctx);
    const demo = await runDemo(ctx);

    // An outreach_email draft's refId is the account id — the join key train-qualifier follows.
    const outreach = demo.pendingDrafts.find((d) => d.kind === "outreach_email");
    expect(outreach).toBeDefined();
    if (!outreach) throw new Error("expected an outreach_email draft from demo");

    // Record a reply against that REAL draft — the return leg that becomes a label-1 example.
    await ctx.memory.putOutcome(
      Outcome.parse({
        id: newId("out"),
        refType: "draft",
        refId: outreach.id,
        result: "replied",
        ts: "2026-07-21T09:00:00.000Z",
      }),
    );

    const text = await captureLog(() => runTrainQualifier(ctx));
    expect(text).toContain("train-qualifier");
    // trained on >=1 example (the joined reply), proving the outcome->draft->account join works.
    expect(text).toMatch(/trained on [1-9]\d* labeled example/);
  });
});
