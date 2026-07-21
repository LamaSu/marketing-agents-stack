# @mstack/console — Autonomous Activation Console

The **SignalSphere AI "Autonomous Activation Console"** web UI (research/04-slides-and-demos.md
§"TALK 2", Guan Wang) over the built account-intelligence backend. A thin Fastify server exposes
the `signal → ML score → agent swarm → draft → human approval` loop as JSON and serves a vanilla
(no framework, no build step, no CDN) dark console under `public/`.

Everything the UI shows is **real backend output** — the ingested signal stream, the RulesScorer
ICP ranking, the SDR-Researcher/Copywriter/GTM-Router decision, and the draft-first approval that
dispatches only through the one gated send path. The "Swarm Reasoning" log narrates the actual
`Decision` payload; it fabricates nothing.

## Run

```bash
# from the repo root (builds workspace deps first via turbo)
pnpm --filter @mstack/console build
pnpm --filter @mstack/console dev      # → http://localhost:4320
```

With **no `ANTHROPIC_API_KEY`** the console runs fully **offline**: deterministic RulesScorer +
sample fixtures, zero network, nothing sent. Set the key → the same endpoints use the live
account-intel swarm. On boot it opens the warehouse (`DATA_DIR`, default `./.data`) and seeds the
sample signals + account universe if the warehouse is empty.

> **DuckDB is single-writer.** Run **one** app at a time against a given `./.data` (the CLI's
> `mstack` and this console share that warehouse). Point a second instance at another `DATA_DIR`
> if you need both up.

Env: `PORT` (4320), `HOST` (0.0.0.0), `DATA_DIR` (./.data), `DRAFTS_DIR` (./drafts),
`OUTBOX_DIR` (./outbox), `ANTHROPIC_API_KEY` (mode switch).

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok, mode }` |
| GET | `/api/stats` | `{ activeAgents, autonomousRuns, pipelineVelocity, … }` — top-bar chips, derived from live warehouse counts |
| GET | `/api/signals?limit=` | `{ mode, signals[] }` — recent ingested `Signal[]` (newest first) |
| GET | `/api/accounts` | `{ mode, accounts[] }` — RulesScorer-ranked `{ domain, name, score, tier, signalCount }` |
| POST | `/api/activate` | `{domain}` → `{ decision{ score, tier, relevantSignals[], buyingCommittee[], nextBestAction }, draftId, draftBody }` |
| GET | `/api/drafts` | `{ drafts[] }` — pending, awaiting approval |
| POST | `/api/drafts/:id/approve` | `approveAndDispatch` → `{ ok, dispatched, outcome, auditVerified }` |

## The four panels (the framework, live)

1. **Snowflake Data Layer — Ingested Signal Stream** — the unified multi-signal feed.
2. **ML Scoring Engine** — ranked ICP accounts with `score/100` badges + tier (click to activate).
3. **Agentic Orchestration Hub** — the three specialized workers + a live monospace Swarm
   Reasoning log; ends at *"Awaiting human validation."*
4. **Resolution & Action Studio** — buying-group persona heatmap, committee, multi-touch timeline,
   the drafted "Agentic Copywriter Sequence" message, and the **Approve** gate.

The **Copilot ↔ Autopilot** toggle relabels the approval gate; in **Autopilot**, low-tier accounts
show as "auto-approve eligible" while **STRONG_FIT / strategic accounts always require a human**.
Mechanically the server never auto-sends — the sole path to the outbox is the explicit approve
call (guardrail #2: a human approves every send).

## Static assets

`public/` is served as-is (not compiled by `tsc`; it lives outside `rootDir: src`). The server
resolves it relative to the compiled module — `dist/server.js` → `../public` → `apps/console/public`
— so there is no copy step and no CWD dependency.

## Test

```bash
pnpm --filter @mstack/console test     # vitest, fully offline, fastify.inject (no socket)
```

`src/server.test.ts` asserts: `/api/accounts` non-empty with numeric, descending scores;
`/api/activate {figma.com}` → a decision citing real `sig_*` ids + a committee + a `draftId`;
approving a pending draft → `200`, `result:"sent"`, hash-chain verified.
