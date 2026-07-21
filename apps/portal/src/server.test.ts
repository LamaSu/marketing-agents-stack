/**
 * server.test.ts — offline, no ANTHROPIC_API_KEY, no bound port. `buildServer()`
 * + `fastify.inject()` exercise the real HTTP surface without a network call.
 * Same temp-dir-per-test pattern as apps/cli/src/demo.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { loadReviewRequests } from "@mstack/reviewer";
import type { ReviewRequest } from "@mstack/core";

import type { PortalContext } from "./context.js";
import { openPortalContext } from "./context.js";
import { selfSeedIfEmpty } from "./seed.js";
import { buildServer } from "./server.js";

const ALL_SIX_CATEGORIES = [
  "guaranteed_outcome",
  "uncited_quantitative",
  "unapproved_superlative",
  "unapproved_spokesperson_quote",
  "roadmap_disclosure",
  "badge_tier_misuse",
];

describe("portal server (offline)", () => {
  let dir: string;
  let ctx: PortalContext;
  let app: FastifyInstance;
  let assets: ReviewRequest[];
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY; // force offline mode, regardless of the shell's env
    dir = await mkdtemp(join(tmpdir(), "mstack-portal-"));
    ctx = await openPortalContext({
      mode: "offline",
      dataDir: join(dir, "data"),
      draftsDir: join(dir, "drafts"),
      outboxDir: join(dir, "outbox"),
      lanceDir: join(dir, "lance"),
      port: 0,
    });
    await selfSeedIfEmpty(ctx.memory, ctx.mode, ctx.paths.lanceDir);
    app = await buildServer(ctx);
    await app.ready();
    assets = await loadReviewRequests();
  });

  afterEach(async () => {
    await app.close();
    await ctx.memory.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  function findAsset(partnerId: string): ReviewRequest {
    const asset = assets.find((r) => r.partnerId === partnerId);
    if (!asset) throw new Error(`fixture missing: expected a "${partnerId}" sample asset`);
    return asset;
  }

  it("GET /api/mode reports offline with no key set", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mode" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "offline" });
  });

  it("GET /api/partners lists the sample partners with their tiers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/partners" });
    expect(res.statusCode).toBe(200);
    const partners = res.json() as Array<{ partnerId: string; partnerTier: string }>;
    expect(partners.length).toBeGreaterThanOrEqual(4);
    expect(partners.find((p) => p.partnerId === "ABC Corp")).toMatchObject({ partnerTier: "Select" });
    expect(partners.find((p) => p.partnerId === "Northland Analytics")).toMatchObject({ partnerTier: "Elite" });
  });

  it("GET /api/sample-draft?partnerId= returns the fixture asset for that partner", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sample-draft?partnerId=ABC%20Corp" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contentTitle: string };
    expect(body.contentTitle).toBe(findAsset("ABC Corp").contentTitle);
  });

  it("GET /api/sample-draft with an unknown partner 404s", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sample-draft?partnerId=Nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/review on the dirty ABC Corp asset returns RETURNED with all six finding categories", async () => {
    const abc = findAsset("ABC Corp");
    const res = await app.inject({ method: "POST", url: "/api/review", payload: abc });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      review: { id: string; verdict: string; score: number; findings: Array<{ category: string; required: boolean }> };
      draftIds: { partnerEmail: string; reviewExport: string };
    };

    expect(body.review.verdict).toBe("RETURNED");
    expect(body.review.score).toBeLessThan(5);

    const categories = new Set(body.review.findings.map((f) => f.category));
    for (const category of ALL_SIX_CATEGORIES) {
      expect(categories.has(category), `expected a "${category}" finding on the ABC Corp asset`).toBe(true);
    }

    expect(body.draftIds.partnerEmail).toBeTruthy();
    expect(body.draftIds.reviewExport).toBeTruthy();
  });

  it("POST /api/review on the clean Northland Analytics asset returns APPROVED", async () => {
    const clean = findAsset("Northland Analytics");
    const res = await app.inject({ method: "POST", url: "/api/review", payload: clean });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { review: { verdict: string; score: number } };
    expect(body.review.verdict).toBe("APPROVED");
    expect(body.review.score).toBe(5);
  });

  it("POST /api/review rejects an invalid body with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/review", payload: { partnerId: "X" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("GET /api/reviews is non-empty after a submission and carries the submitted title", async () => {
    const abc = findAsset("ABC Corp");
    await app.inject({ method: "POST", url: "/api/review", payload: abc });

    const res = await app.inject({ method: "GET", url: "/api/reviews" });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ partnerId: string; contentTitle: string; verdict: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ partnerId: "ABC Corp", contentTitle: abc.contentTitle, verdict: "RETURNED" });
  });

  it("GET /api/reviews/:id returns findings + the linked partner-email draft body", async () => {
    const abc = findAsset("ABC Corp");
    const submit = await app.inject({ method: "POST", url: "/api/review", payload: abc });
    const { review } = submit.json() as { review: { id: string } };

    const res = await app.inject({ method: "GET", url: `/api/reviews/${review.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { contentTitle: string };
      drafts: { partnerEmail: { body: string } | null };
    };
    expect(body.meta.contentTitle).toBe(abc.contentTitle);
    expect(body.drafts.partnerEmail?.body).toContain(abc.contentTitle);
  });

  it("GET /api/reviews/:id 404s for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/reviews/rev_does_not_exist" });
    expect(res.statusCode).toBe(404);
  });

  it("approving a draft dispatches it: 200, status dispatched, outcome sent", async () => {
    const abc = findAsset("ABC Corp");
    const submit = await app.inject({ method: "POST", url: "/api/review", payload: abc });
    const { draftIds } = submit.json() as { draftIds: { partnerEmail: string } };

    const before = await app.inject({ method: "GET", url: "/api/drafts" });
    expect((before.json() as unknown[]).length).toBeGreaterThan(0);

    const res = await app.inject({ method: "POST", url: `/api/drafts/${draftIds.partnerEmail}/approve` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: { result: string }; draft: { status: string } };
    expect(body.outcome.result).toBe("sent");
    expect(body.draft.status).toBe("dispatched");
  });

  it("approving an unknown draft 404s", async () => {
    const res = await app.inject({ method: "POST", url: "/api/drafts/draft_does_not_exist/approve" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/internal tallies approved/returned per partner across all sample assets", async () => {
    for (const asset of assets) {
      const res = await app.inject({ method: "POST", url: "/api/review", payload: asset });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({ method: "GET", url: "/api/internal" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      partners: Array<{ partnerId: string; approved: number; returned: number }>;
      totals: { approved: number; returned: number; total: number };
    };
    expect(body.totals.total).toBe(assets.length);
    // Northland Analytics is the one planted-clean asset (data/README.md).
    const northland = body.partners.find((p) => p.partnerId === "Northland Analytics");
    expect(northland).toMatchObject({ approved: 1, returned: 0 });
  });

  it("GET / serves the portal's static index page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Partner Content Portal");
  });
});
