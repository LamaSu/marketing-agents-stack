/**
 * server.test.ts — the console API, fully OFFLINE (no ANTHROPIC_API_KEY), against an
 * in-memory DuckDB and temp drafts/outbox dirs, driven by `fastify.inject` (no socket).
 *
 * Asserts the four load-bearing behaviors:
 *   1. GET  /api/accounts       → non-empty, numeric scores, ranked high→low
 *   2. POST /api/activate figma → a decision citing REAL signalIds + a committee + a draftId
 *   3. GET  /api/drafts + approve → 200, dispatched (result:"sent"), hash-chain verifies
 *   4. GET  /api/stats          → derived numeric chips
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { buildServer } from "./server.js";

describe("@mstack/console API (offline, injected)", () => {
  let app: FastifyInstance;
  let tmp: string;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY; // force offline mode
    tmp = await mkdtemp(join(tmpdir(), "mstack-console-"));
    app = await buildServer({
      memoryPath: ":memory:",
      draftsDir: join(tmp, "drafts"),
      outboxDir: join(tmp, "outbox"),
      mode: "offline",
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close(); // onClose → memory.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("GET /api/accounts returns ranked accounts with numeric scores", async () => {
    const res = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      mode: string;
      accounts: Array<{ domain: string; name: string; score: number; tier: string; signalCount: number }>;
    };
    expect(body.mode).toBe("offline");
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts.length).toBeGreaterThan(0);

    for (const a of body.accounts) {
      expect(typeof a.score).toBe("number");
      expect(Number.isFinite(a.score)).toBe(true);
      expect(typeof a.tier).toBe("string");
    }

    // ranked high → low
    const scores = body.accounts.map((a) => a.score);
    const sorted = [...scores].sort((x, y) => y - x);
    expect(scores).toEqual(sorted);
  });

  it("POST /api/activate {figma.com} → a decision citing real signalIds + committee + draftId", async () => {
    const res = await app.inject({ method: "POST", url: "/api/activate", payload: { domain: "figma.com" } });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      decision: {
        score: number;
        tier: string;
        relevantSignals: Array<{ signalId: string; why: string }>;
        buyingCommittee: Array<{ name: string; persona: string }>;
      };
      draftId: string;
      draftBody: string;
    };

    // relevant signals are REAL persisted ids, never invented (guardrail #6)
    expect(body.decision.relevantSignals.length).toBeGreaterThan(0);
    for (const s of body.decision.relevantSignals) {
      expect(s.signalId.startsWith("sig_")).toBe(true);
    }

    // a resolved buying committee + a draft to approve
    expect(body.decision.buyingCommittee.length).toBeGreaterThan(0);
    expect(typeof body.draftId).toBe("string");
    expect(body.draftId.length).toBeGreaterThan(0);
    expect(body.draftBody.length).toBeGreaterThan(0);
  });

  it("GET /api/drafts then POST approve → 200 + dispatched + audit verified", async () => {
    // guarantee at least one pending draft exists
    await app.inject({ method: "POST", url: "/api/activate", payload: { domain: "airtable.com" } });

    const list = await app.inject({ method: "GET", url: "/api/drafts" });
    expect(list.statusCode).toBe(200);
    const drafts = (list.json() as { drafts: Array<{ id: string; status: string }> }).drafts;
    expect(drafts.length).toBeGreaterThan(0);

    const first = drafts[0];
    if (!first) throw new Error("expected at least one pending draft");
    expect(first.status).toBe("pending");

    const appr = await app.inject({ method: "POST", url: `/api/drafts/${first.id}/approve` });
    expect(appr.statusCode).toBe(200);
    const out = appr.json() as { dispatched: boolean; outcome: { result: string }; auditVerified: boolean };
    expect(out.dispatched).toBe(true);
    expect(out.outcome.result).toBe("sent");
    expect(out.auditVerified).toBe(true);
  });

  it("POST /api/activate with no domain → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/activate", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/stats returns derived numeric chips", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(200);
    const s = res.json() as { activeAgents: number; autonomousRuns: number; pipelineVelocity: number };
    expect(s.activeAgents).toBeGreaterThan(0);
    expect(typeof s.autonomousRuns).toBe("number");
    expect(s.autonomousRuns).toBeGreaterThan(0); // figma + airtable activations ran above
    expect(typeof s.pipelineVelocity).toBe("number");
  });
});
