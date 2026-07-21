#!/usr/bin/env node
/**
 * server.ts — the Partner Content Portal (research/04-slides-and-demos.md TALK 1;
 * research/06-architecture.md W5-T1). A Fastify server over the SAME runtime the
 * CLI uses (`runContentReview`, `DraftStore`, `approveAndDispatch`) — the portal
 * is a thin HTTP face on the real workflow, not a separate implementation of it.
 *
 * MODE: live iff ANTHROPIC_API_KEY is set, else offline — identical rule to the
 * CLI (`context.ts#detectMode`), surfaced to the UI via `GET /api/mode`.
 *
 * STATIC ASSETS: `public/` is served AS-IS (no bundler, no CDN) via
 * `@fastify/static`, resolved relative to THIS FILE (`../public`) rather than
 * copied into `dist/` at build time — `tsc` only compiles `.ts`, it does not
 * copy static assets. Resolving `../public` from `import.meta.url` works
 * identically whether this file is running compiled (`dist/server.js` ->
 * `apps/portal/public`) or straight from source (`src/server.ts` ->
 * `apps/portal/public`), since both `src/` and `dist/` sit exactly one level
 * under `apps/portal/`. `pnpm --filter @mstack/portal dev` runs the compiled
 * `dist/server.js` per this package's `dev` script, but the resolution is
 * build-mode-agnostic by construction.
 *
 * TESTABILITY: `buildServer()` builds and returns the Fastify instance without
 * calling `.listen()` — `server.test.ts` uses it directly with `.inject()` (no
 * real port bound). `main()` is the process entrypoint; it is guarded so that
 * importing this module (as the test file does, to reach `buildServer`) never
 * triggers a real `.listen()` call as a side effect of the import.
 */
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";

import { Draft, Review, ReviewRequest } from "@mstack/core";
import { LocalOutreachChannel, approveAndDispatch, runContentReview } from "@mstack/runtime";
import { loadReviewRequests } from "@mstack/reviewer";

import type { PortalContext } from "./context.js";
import { openPortalContext } from "./context.js";
import { selfSeedIfEmpty } from "./seed.js";
import { buildLiveCorpus, loadGuidelines, liveReviewFn, offlineReviewFn } from "./reviewers.js";
import { getReviewMeta, rememberReviewMeta } from "./dashboard.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const DEFAULT_ACTOR = "portal-user";

/** Build the Fastify instance against an already-open `PortalContext`. Registers
 *  every `/api/*` route + the static `public/` mount, but does NOT call
 *  `.listen()` — the caller decides (real boot vs. `.inject()` in tests). */
export async function buildServer(ctx: PortalContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // One reviewFn built once per process, mode-appropriate — mirrors
  // apps/cli/src/demo.ts's construction of the same seam.
  const reviewFn =
    ctx.mode === "live"
      ? liveReviewFn(await buildLiveCorpus(ctx.paths.lanceDir))
      : offlineReviewFn(await loadGuidelines(ctx.memory));

  const channel = new LocalOutreachChannel(ctx.paths.outboxDir);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      reply.code(400).send({ error: "invalid request", issues: err.issues });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  /* ── GET /api/mode — mirrors the CLI's printModeBanner ─────────────── */
  app.get("/api/mode", async () => ({
    mode: ctx.mode,
    detail:
      ctx.mode === "live"
        ? "ANTHROPIC_API_KEY set — Claude judge active (extract → retrieve → judge)"
        : "no ANTHROPIC_API_KEY — deterministic + rules, zero network",
  }));

  /* ── GET /api/partners — partner list + tier, from the sample assets ── */
  app.get("/api/partners", async () => {
    const requests = await loadReviewRequests();
    const byPartner = new Map<string, ReviewRequest["partnerTier"]>();
    for (const r of requests) byPartner.set(r.partnerId, r.partnerTier);
    return [...byPartner.entries()].map(([partnerId, partnerTier]) => ({ partnerId, partnerTier }));
  });

  /* ── GET /api/sample-draft?partnerId= — "Load sample draft" ─────────── */
  app.get<{ Querystring: { partnerId?: string } }>("/api/sample-draft", async (req, reply) => {
    const { partnerId } = req.query;
    if (!partnerId) {
      reply.code(400).send({ error: "missing required query param 'partnerId'" });
      return;
    }
    const requests = await loadReviewRequests();
    const sample = requests.find((r) => r.partnerId === partnerId);
    if (!sample) {
      reply.code(404).send({ error: `no sample asset for partner "${partnerId}"` });
      return;
    }
    return sample;
  });

  /* ── POST /api/review — the actual submit-for-review action ─────────── */
  app.post<{ Body: unknown }>("/api/review", async (req) => {
    const parsed = ReviewRequest.parse(req.body);
    const result = await runContentReview(parsed, {
      reviewFn,
      memory: ctx.memory,
      draftStore: ctx.draftStore,
    });

    rememberReviewMeta(result.review.id, {
      contentTitle: parsed.contentTitle,
      contentType: parsed.contentType,
    });

    return {
      review: result.review,
      draftIds: { partnerEmail: result.drafts.partnerEmail.id, reviewExport: result.drafts.reviewExport.id },
    };
  });

  /* ── GET /api/reviews — Review Dashboard rows ────────────────────────── */
  app.get("/api/reviews", async () => {
    const reviews = await ctx.memory.listReviews();
    return reviews.map((r) => {
      const meta = getReviewMeta(r.id);
      return {
        id: r.id,
        partnerId: r.partnerId,
        partnerTier: r.partnerTier,
        contentTitle: meta.contentTitle,
        contentType: meta.contentType,
        createdAt: r.createdAt,
        verdict: r.verdict,
        score: r.score,
        findingsCount: r.findings.length,
      };
    });
  });

  /* ── GET /api/reviews/:id — full detail: findings + linked drafts ────── */
  app.get<{ Params: { id: string } }>("/api/reviews/:id", async (req, reply) => {
    const { id } = req.params;
    const rows = await ctx.memory.query<{ data: string }>("SELECT data FROM reviews WHERE id = $id", { id });
    const row = rows[0];
    if (!row) {
      reply.code(404).send({ error: `no review with id "${id}"` });
      return;
    }
    const review = Review.parse(JSON.parse(row.data));

    const draftRows = await ctx.memory.query<{ data: string }>("SELECT data FROM drafts WHERE ref_id = $id", { id });
    const drafts = draftRows.map((d) => Draft.parse(JSON.parse(d.data)));
    const partnerEmail = drafts.find((d) => d.kind === "partner_email") ?? null;
    const reviewExport = drafts.find((d) => d.kind === "review_export") ?? null;

    return { review, meta: getReviewMeta(id), drafts: { partnerEmail, reviewExport } };
  });

  /* ── GET /api/drafts — drafts awaiting approval (INTERNAL tab) ───────── */
  app.get("/api/drafts", async () => ctx.draftStore.listPending());

  /* ── POST /api/drafts/:id/approve — the one human-gated send path ────── */
  app.post<{ Params: { id: string } }>("/api/drafts/:id/approve", async (req, reply) => {
    const { id } = req.params;
    const existing = await ctx.memory.getDraft(id);
    if (!existing) {
      reply.code(404).send({ error: `no draft with id "${id}"` });
      return;
    }
    const outcome = await approveAndDispatch(id, DEFAULT_ACTOR, channel, {
      memory: ctx.memory,
      draftStore: ctx.draftStore,
    });
    const draft = await ctx.memory.getDraft(id);
    return { outcome, draft };
  });

  /* ── GET /api/internal — approved/returned ledger per partner ────────── */
  app.get("/api/internal", async () => {
    const reviews = await ctx.memory.listReviews();
    const byPartner = new Map<string, { approved: number; returned: number }>();
    for (const r of reviews) {
      const row = byPartner.get(r.partnerId) ?? { approved: 0, returned: 0 };
      if (r.verdict === "APPROVED") row.approved += 1;
      else row.returned += 1;
      byPartner.set(r.partnerId, row);
    }
    const partners = [...byPartner.entries()].map(([partnerId, counts]) => ({
      partnerId,
      approved: counts.approved,
      returned: counts.returned,
      total: counts.approved + counts.returned,
    }));
    const totals = partners.reduce(
      (acc, p) => ({
        approved: acc.approved + p.approved,
        returned: acc.returned + p.returned,
        total: acc.total + p.total,
      }),
      { approved: 0, returned: 0, total: 0 },
    );
    return { partners, totals };
  });

  /* ── static UI (public/index.html + style.css + app.js), served as-is ── */
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

  return app;
}

async function main(): Promise<void> {
  const ctx = await openPortalContext();
  const seedResult = await selfSeedIfEmpty(ctx.memory, ctx.mode, ctx.paths.lanceDir);
  const app = await buildServer(ctx);

  try {
    await app.listen({ port: ctx.port, host: "0.0.0.0" });
    console.log("─".repeat(72));
    console.log(`Partner Content Portal — mode: ${ctx.mode.toUpperCase()}`);
    console.log(`  listening: http://localhost:${ctx.port}`);
    console.log(`  data dir:  ${ctx.paths.dataDir}`);
    console.log(
      seedResult.seeded
        ? `  self-seeded ${seedResult.guidelines} guideline rows (no prior "mstack seed" found)`
        : `  guidelines already seeded (${seedResult.guidelines} rows) — using the existing warehouse`,
    );
    console.log('  submit content, then check the "Review Dashboard" and "INTERNAL" tabs.');
    console.log("─".repeat(72));
  } catch (err) {
    console.error(`portal: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    await ctx.memory.close();
    process.exitCode = 1;
  }
}

// Only run the server when this file is the actual process entrypoint (`node
// dist/server.js`) — never as a side effect of another module importing
// `buildServer` (see server.test.ts). Standard Node ESM "is this main" check:
// compare the resolved filesystem path of this module to argv[1] (both run
// through `fileURLToPath`/as-is so Windows path formatting matches).
const entryArg = process.argv[1];
const isMain = entryArg !== undefined && fileURLToPath(import.meta.url) === entryArg;
if (isMain) {
  void main();
}
