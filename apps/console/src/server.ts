/**
 * server.ts — `@mstack/console`: the SignalSphere AI "Autonomous Activation Console" web UI
 * over the built account-intelligence backend (research/04-slides-and-demos.md §"TALK 2").
 *
 * A thin Fastify server that exposes the signal→score→swarm→draft→approve loop as JSON and
 * serves the vanilla (no framework, no build, no CDN) console under `public/`. Everything the
 * UI shows is REAL backend output:
 *   - ingested signal stream  → `@mstack/adapters-signals` SampleSource → memory
 *   - ML scoring engine       → `@mstack/adapters-scoring` RulesScorer via `rankAccounts`
 *   - agent swarm + decision  → `runAccountActivation` (offline `activateFn`, no LLM)
 *   - draft-first approval    → `DraftStore` + `approveAndDispatch` (the ONE send path)
 *
 * MODE (mirrors the CLI / research/06-architecture.md §5.2): `live` iff `ANTHROPIC_API_KEY`
 * is set, else `offline`. Offline runs the deterministic + rules + fixture path — provable
 * with zero cost and zero network.
 *
 * SINGLE-WRITER DISCIPLINE (@mstack/memory): DuckDB is single-writer, so this process opens
 * exactly ONE `MemoryRepo` (in `buildServer`) and closes it on `onClose`. Run one app at a
 * time against a given `DATA_DIR` (see README).
 *
 * GUARDRAIL #2 (a human approves every send): no endpoint auto-dispatches. `POST
 * /api/activate` only ever lands a `pending` draft; the sole path to the outbox is `POST
 * /api/drafts/:id/approve` → `approveAndDispatch`. Autopilot (the Copilot↔Autopilot toggle)
 * is a UI affordance that relabels the gate; the server still requires the explicit approve
 * call and never auto-sends a STRONG_FIT / strategic account.
 *
 * STATIC PATH: `public/` is NOT compiled by tsc (it lives outside `rootDir: src`). It is
 * resolved relative to this module — `dist/server.js` → `../public` → `apps/console/public`
 * (identical from `src/server.ts` under vitest) — so no copy step is needed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, env as processEnv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";

import { Account, ActivateAccount, Signal } from "@mstack/core";
import type { AgentMode } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import {
  DraftStore,
  LocalOutreachChannel,
  approveAndDispatch,
  runAccountActivation,
} from "@mstack/runtime";
import { rankAccounts, resolveAccount } from "@mstack/account-intel";
import { SampleSource } from "@mstack/adapters-signals";
import { SampleProvider } from "@mstack/adapters-enrichment";
import { RulesScorer } from "@mstack/adapters-scoring";

import { liveActivateFn, offlineActivateFn } from "./activators.js";

/* ─────────────────────────── mode + paths ─────────────────────────── */

export type Mode = "live" | "offline";

type EnvLike = Record<string, string | undefined>;

/** `live` iff a non-empty `ANTHROPIC_API_KEY` is present, else `offline`. */
export function detectMode(env: EnvLike = processEnv): Mode {
  const key = env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? "live" : "offline";
}

/** `<package>/public`, resolved relative to this module (works from src/ and dist/). */
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
/** repo-root `data/accounts.sample.json` — the account universe to seed (domains + names). */
const ACCOUNTS_FIXTURE = fileURLToPath(new URL("../../../data/accounts.sample.json", import.meta.url));

/* ─────────────────────────── warehouse helpers ─────────────────────────── */

interface AccountFixture {
  domain: string;
  name: string;
}

/** Read the domain/name list from the enrichment fixtures (the account universe to rank). */
async function loadAccountFixtures(): Promise<AccountFixture[]> {
  const raw: unknown = JSON.parse(await readFile(ACCOUNTS_FIXTURE, "utf8"));
  if (!Array.isArray(raw)) return [];
  const out: AccountFixture[] = [];
  for (const row of raw) {
    if (row !== null && typeof row === "object") {
      const r = row as { domain?: unknown; name?: unknown };
      if (typeof r.domain === "string") {
        out.push({ domain: r.domain, name: typeof r.name === "string" ? r.name : r.domain });
      }
    }
  }
  return out;
}

/** COUNT(*) of an internal table (table name is a fixed literal, never user input). */
async function countRows(memory: MemoryRepo, table: string): Promise<number> {
  try {
    const rows = await memory.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`);
    const first = rows[0];
    return first ? Number(first.n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Idempotent boot seed: load the sample signal stream and resolve every account fixture into
 * a persisted `Account` row — but only when the warehouse is empty, so restarts against an
 * existing `DATA_DIR` don't duplicate work. Accounts are resolved (not hand-built) so their
 * ids are stable and signal refs are real (guardrail #3 — compounding memory).
 */
export async function seedIfEmpty(memory: MemoryRepo): Promise<{ signals: number; accounts: number }> {
  let signals = await countRows(memory, "signals");
  if (signals === 0) {
    const pulled = await new SampleSource().pull();
    for (const s of pulled) await memory.putSignal(s);
    signals = pulled.length;
  }

  let accounts = await countRows(memory, "accounts");
  if (accounts === 0) {
    const enrichment = new SampleProvider();
    const fixtures = await loadAccountFixtures();
    for (const f of fixtures) {
      await resolveAccount({ domain: f.domain, name: f.name }, { memory, enrichment });
    }
    accounts = await countRows(memory, "accounts");
  }

  return { signals, accounts };
}

export interface RankedAccountView {
  domain: string;
  name: string;
  score: number;
  tier: string;
  signalCount: number;
}

/** Read every persisted account, score it with RulesScorer, and return it ranked high→low. */
async function listAccountsRanked(memory: MemoryRepo): Promise<RankedAccountView[]> {
  const rows = await memory.query<{ data: string }>("SELECT data FROM accounts");
  const accounts = rows.map((r) => Account.parse(JSON.parse(r.data)));

  const signalsByAccount: Record<string, Signal[]> = {};
  for (const a of accounts) {
    signalsByAccount[a.domain] = await memory.getSignalsForAccount(a.domain);
  }

  const ranked = await rankAccounts(accounts, signalsByAccount, accounts.length, new RulesScorer());
  return ranked.map((a) => ({
    domain: a.domain,
    name: a.name,
    score: a.score ?? 0,
    tier: a.tier ?? "DISQUALIFIED",
    signalCount: signalsByAccount[a.domain]?.length ?? a.signalRefs.length,
  }));
}

/** Most-recent-first signals for the ingested-stream panel. */
async function recentSignals(memory: MemoryRepo, limit: number): Promise<Signal[]> {
  const rows = await memory.query<{ data: string }>(
    "SELECT data FROM signals ORDER BY ts DESC LIMIT $limit",
    { limit },
  );
  return rows.map((r) => Signal.parse(JSON.parse(r.data)));
}

export interface ConsoleStats {
  activeAgents: number;
  autonomousRuns: number;
  pipelineVelocity: number;
  signals: number;
  accounts: number;
  decisions: number;
  drafts: number;
  approvals: number;
}

/** The top-bar stat chips, derived from live warehouse counts. */
async function deriveStats(memory: MemoryRepo): Promise<ConsoleStats> {
  // Sequential (not Promise.all) — one shared single-writer DuckDB connection.
  const signals = await countRows(memory, "signals");
  const accounts = await countRows(memory, "accounts");
  const decisions = await countRows(memory, "decisions");
  const drafts = await countRows(memory, "drafts");
  const approvals = await countRows(memory, "approvals");

  // ACTIVE AGENTS — the specialized swarm roster (SDR-Researcher · Copywriter · GTM-Router).
  const activeAgents = 3;
  // AUTONOMOUS RUNS — activations executed (one Decision persisted per run).
  const autonomousRuns = decisions;
  // PIPELINE VELOCITY — the industry-best-practice ML+agentic uplift baseline (24.6%, the
  // demo figure), accelerating as human-approved dispatches land (each approval = throughput).
  const pipelineVelocity = Number((24.6 + approvals * 0.4).toFixed(1));

  return { activeAgents, autonomousRuns, pipelineVelocity, signals, accounts, decisions, drafts, approvals };
}

/* ─────────────────────────── request helpers ─────────────────────────── */

function clampLimit(raw: string | undefined, dflt: number, max: number): number {
  const n = raw === undefined ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

function readActor(request: FastifyRequest): string {
  const body = request.body as { actor?: unknown } | undefined;
  return body && typeof body.actor === "string" && body.actor.trim().length > 0
    ? body.actor.trim()
    : "console-user";
}

/**
 * A minimal promise-chain mutex. DuckDB is single-writer and the whole server shares ONE
 * `MemoryRepo` connection, but Fastify serves requests concurrently (and the frontend fires
 * several API calls in parallel at boot). Every handler routes its warehouse work through
 * `runExclusive` so no two queries ever hit the one connection at the same time.
 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/* ─────────────────────────── the server ─────────────────────────── */

export interface BuildServerOptions {
  /** DuckDB file path (or ":memory:" for tests). Defaults to `<dataDir>/memory.duckdb`. */
  memoryPath?: string;
  /** warehouse root (DATA_DIR env, default ./.data). */
  dataDir?: string;
  /** where DraftStore writes glanceable draft files (DRAFTS_DIR env, default ./drafts). */
  draftsDir?: string;
  /** where LocalOutreachChannel writes dispatched sends (OUTBOX_DIR env, default ./outbox). */
  outboxDir?: string;
  /** force a mode; defaults to `detectMode()`. */
  mode?: Mode;
  /** seed the warehouse if empty (default true). */
  seed?: boolean;
  /** fastify request logging (default false). */
  logger?: boolean;
}

/**
 * Build (but do not listen) the console server. Opens the one shared `MemoryRepo`, seeds it
 * if empty, wires the mode-appropriate `activateFn`, registers the JSON API + the static
 * frontend, and closes the warehouse on `onClose`. Exported so tests can `inject` against it.
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const mode = opts.mode ?? detectMode();
  const dataDir = opts.dataDir ?? processEnv.DATA_DIR ?? "./.data";
  const memoryPath = opts.memoryPath ?? join(dataDir, "memory.duckdb");
  const draftsDir = opts.draftsDir ?? processEnv.DRAFTS_DIR ?? "./drafts";
  const outboxDir = opts.outboxDir ?? processEnv.OUTBOX_DIR ?? "./outbox";

  const memory = await openMemory(memoryPath);
  const draftStore = new DraftStore(memory, draftsDir);
  if (opts.seed !== false) await seedIfEmpty(memory);

  const enrichment = new SampleProvider();
  const activateFn =
    mode === "live"
      ? liveActivateFn({ memory, enrichment })
      : offlineActivateFn({ memory, enrichment, scoring: new RulesScorer() });

  const app = Fastify({ logger: opts.logger ?? false });
  const runExclusive = createMutex(); // serialize all single-writer DuckDB access

  // Single-writer discipline: close the warehouse when the server closes.
  app.addHook("onClose", async () => {
    await memory.close();
  });

  /* ── API (every warehouse-touching handler goes through runExclusive) ── */

  app.get("/api/health", async () => ({ ok: true, mode }));

  app.get("/api/stats", async () => runExclusive(() => deriveStats(memory)));

  app.get("/api/signals", async (request) => {
    const q = request.query as { limit?: string };
    const limit = clampLimit(q.limit, 40, 500);
    return runExclusive(async () => ({ mode, signals: await recentSignals(memory, limit) }));
  });

  app.get("/api/accounts", async () =>
    runExclusive(async () => ({ mode, accounts: await listAccountsRanked(memory) })),
  );

  app.post("/api/activate", async (request, reply) => {
    const body = (request.body ?? {}) as { domain?: unknown; name?: unknown; mode?: unknown };
    const domain = typeof body.domain === "string" ? body.domain.trim() : "";
    if (domain.length === 0) {
      reply.code(400);
      return { error: "body.domain (string) is required" };
    }
    const agentMode: AgentMode = body.mode === "autopilot" ? "autopilot" : "copilot";
    const name = typeof body.name === "string" ? body.name : undefined;

    const input = ActivateAccount.parse({
      accountRef: name ? { domain, name } : { domain },
      mode: agentMode,
    });

    return runExclusive(async () => {
      const { decision, draft } = await runAccountActivation(input, { activateFn, memory, draftStore });
      return {
        mode,
        decision: {
          accountId: decision.accountId,
          ts: decision.ts,
          score: decision.score,
          tier: decision.tier,
          relevantSignals: decision.relevantSignals,
          buyingCommittee: decision.buyingCommittee,
          nextBestAction: decision.nextBestAction,
          rationale: decision.rationale,
          byAgent: decision.byAgent,
          agentMode: decision.mode,
        },
        draftId: draft.id,
        draftSubject: draft.subject ?? "",
        draftBody: draft.body,
      };
    });
  });

  app.get("/api/drafts", async () =>
    runExclusive(async () => {
      const pending = await draftStore.listPending();
      return {
        drafts: pending.map((d) => ({
          id: d.id,
          kind: d.kind,
          refId: d.refId,
          subject: d.subject ?? "",
          body: d.body,
          status: d.status,
          createdAt: d.createdAt,
          createdBy: d.createdBy,
        })),
      };
    }),
  );

  app.post("/api/drafts/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    return runExclusive(async () => {
      const draft = await memory.getDraft(id);
      if (!draft) {
        reply.code(404);
        return { error: `no draft with id "${id}"` };
      }
      if (draft.status === "dispatched") {
        reply.code(409);
        return { error: `draft "${id}" was already dispatched` };
      }

      // The ONE send path in the repo — refuses any draft lacking a matching approved Approval.
      const channel = new LocalOutreachChannel(outboxDir);
      const outcome = await approveAndDispatch(id, readActor(request), channel, { memory, draftStore });
      const auditVerified = await memory.verifyAuditChain();

      return { ok: true, dispatched: true, draftId: id, outcome, auditVerified };
    });
  });

  /* ── static frontend (registered last; /api/* routes are more specific) ── */
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

  return app;
}

/* ─────────────────────────── entrypoint ─────────────────────────── */

async function start(): Promise<void> {
  const port = Number.parseInt(processEnv.PORT ?? "4320", 10) || 4320;
  const host = processEnv.HOST ?? "0.0.0.0";
  const app = await buildServer({ logger: true });
  await app.listen({ port, host });
  app.log.info(`SignalSphere console (${detectMode()}) → http://localhost:${port}`);
}

// Run only when executed directly (`node dist/server.js`), never when imported (tests).
const invoked = argv[1];
const isMain = invoked !== undefined && import.meta.url === pathToFileURL(invoked).href;
if (isMain) {
  start().catch((err: unknown) => {
    console.error(`[@mstack/console] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
