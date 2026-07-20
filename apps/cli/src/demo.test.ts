/**
 * demo.test.ts — the make-or-break integration test: seed + demo run offline,
 * both workflows land drafts, NOTHING dispatches, then approving one draft sends
 * it and the hash-chained audit verifies. Fully offline (no ANTHROPIC_API_KEY),
 * temp DATA_DIR / DRAFTS_DIR / OUTBOX_DIR / LANCE_DIR.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalOutreachChannel, approveAndDispatch } from "@mstack/runtime";

import type { CliContext } from "./context.js";
import { openContext } from "./context.js";
import { runSeed } from "./seed.js";
import { runDemo } from "./demo.js";

describe("mstack offline demo (end-to-end)", () => {
  let dir: string;
  let ctx: CliContext;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY; // force offline mode
    dir = await mkdtemp(join(tmpdir(), "mstack-cli-"));
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

  it("seeds, runs both workflows, dispatches nothing, then approves one draft", async () => {
    const seed = await runSeed(ctx);
    expect(seed.mode).toBe("offline");
    expect(seed.signals).toBeGreaterThan(0);
    expect(seed.guidelines).toBeGreaterThan(0);
    expect(seed.enrichmentFixtures).toBeGreaterThan(0);

    const demo = await runDemo(ctx);
    expect(demo.mode).toBe("offline");

    // dirty ABC Corp asset → RETURNED with findings
    const abc = demo.reviews.find((r) => r.partnerId === "ABC Corp");
    expect(abc).toBeDefined();
    if (!abc) throw new Error("expected an ABC Corp review");
    expect(abc.verdict).toBe("RETURNED");
    expect(abc.totalFindings).toBeGreaterThan(0);

    // clean Northland Analytics asset → APPROVED
    const clean = demo.reviews.find((r) => r.partnerId === "Northland Analytics");
    expect(clean).toBeDefined();
    if (!clean) throw new Error("expected a Northland Analytics review");
    expect(clean.verdict).toBe("APPROVED");

    // ≥1 account Decision, ≥1 pending draft
    expect(demo.decisions.length).toBeGreaterThanOrEqual(1);
    expect(demo.pendingDrafts.length).toBeGreaterThanOrEqual(1);

    // relevant signals are REAL ids (never invented) — guardrail #6
    for (const d of demo.decisions) {
      expect(d.relevantSignalIds.every((id) => id.startsWith("sig_"))).toBe(true);
    }

    // outbox EMPTY — nothing was sent
    expect(demo.outboxCount).toBe(0);
    const outboxBefore = await readdir(ctx.paths.outboxDir).catch(() => [] as string[]);
    expect(outboxBefore.filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // approve one draft → it lands in the outbox + the audit chain verifies
    const first = demo.pendingDrafts[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected at least one pending draft");

    const outcome = await approveAndDispatch(first.id, "demo-user", new LocalOutreachChannel(ctx.paths.outboxDir), {
      memory: ctx.memory,
      draftStore: ctx.draftStore,
    });
    expect(outcome.result).toBe("sent");

    const outboxAfter = await readdir(ctx.paths.outboxDir);
    expect(outboxAfter).toContain(`${first.id}.json`);

    const dispatched = await ctx.memory.getDraft(first.id);
    expect(dispatched?.status).toBe("dispatched");
    expect(await ctx.memory.verifyAuditChain()).toBe(true);
  });

  it("is idempotent: re-seeding does not change signal/guideline counts", async () => {
    const a = await runSeed(ctx);
    const b = await runSeed(ctx);
    expect(b.signals).toBe(a.signals);
    expect(b.guidelines).toBe(a.guidelines);
  });
});
