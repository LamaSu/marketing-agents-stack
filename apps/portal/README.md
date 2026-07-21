# @mstack/portal

The **Partner Content Portal** — the web UI for the Asset-Review / Claim-Drift agent
(`research/04-slides-and-demos.md` TALK 1; `research/06-architecture.md` W5-T1). A Fastify
server that is a thin HTTP face on the real `@mstack/runtime` content-review workflow — the
same `runContentReview` / `DraftStore` / `approveAndDispatch` the CLI uses, not a separate
reimplementation. Three tabs: **Submit Content** (form + the review rubric), **Review
Dashboard** (every review, color-coded RETURNED/APPROVED), **INTERNAL** (the approved/returned
ledger per partner + drafts awaiting approval).

## Quickstart

```bash
pnpm --filter @mstack/portal dev
```

then open **http://localhost:4310**. Mode is **live** iff `ANTHROPIC_API_KEY` is set (Claude
extract → retrieve → judge), else **offline** (deterministic rule-scan only, zero network) —
shown as a badge in the header, same rule as the CLI (`mstack`'s mode banner).

You do not need to run `mstack seed` first — the portal **self-seeds** the guideline rule rows
(+ the reviewer corpus, guarded) on boot if the warehouse is empty. If you already ran
`mstack seed`, the portal reuses that same data instead of reseeding (idempotent either way).

**DuckDB is single-writer** (`@mstack/memory`): run only **one** app (`portal`, `console`, or
the `mstack` CLI) against a given `./.data` directory at a time. Point `DATA_DIR` at separate
directories if you want to run more than one concurrently.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/mode` | `{ mode: "offline"\|"live", detail }` — for the header badge |
| `GET /api/partners` | `[{ partnerId, partnerTier }]`, derived from `data/corpus/assets/assets.json` |
| `GET /api/sample-draft?partnerId=` | The sample submitted content for that partner ("Load sample draft") |
| `POST /api/review` | Body = a `ReviewRequest` (`partnerId, partnerTier, contentTitle, contentType, content`). Runs `runContentReview` → `{ review, draftIds }` |
| `GET /api/reviews` | Review Dashboard rows: `[{ id, partnerId, contentTitle, createdAt, verdict, score, findingsCount, … }]` |
| `GET /api/reviews/:id` | Full detail: `{ review, meta, drafts: { partnerEmail, reviewExport } }` — powers both the Submit-tab "View drafted partner email" and a Dashboard row click |
| `GET /api/drafts` | Drafts currently awaiting approval (`DraftStore.listPending()`) |
| `POST /api/drafts/:id/approve` | The one human-gated send path (`approveAndDispatch` + `LocalOutreachChannel`) → `{ outcome, draft }` |
| `GET /api/internal` | Approved/returned tallies per partner, for the INTERNAL ledger |
| `GET /` and other static paths | `public/index.html` + `style.css` + `app.js`, served as-is |

All five `ReviewRequest`/`Review`/`Draft`/etc. shapes are the real `@mstack/core` Zod schemas —
the portal validates inbound bodies through them (`ReviewRequest.parse`), so a malformed
submission 400s with the Zod issue list rather than reaching the reviewer.

## Static assets

`public/` (`index.html`, `style.css`, `app.js`) is a self-contained, vanilla, no-build-step,
no-CDN frontend — it has to work fully offline. It is served via `@fastify/static` from a path
resolved relative to `server.ts` itself (`../public`), **not** copied into `dist/` at build
time: `tsc` only compiles `.ts`, so nothing would populate a `dist/public/` copy. Because both
`src/` and `dist/` sit exactly one directory below `apps/portal/`, `../public` resolves to the
same real directory whether `server.ts` is running compiled (`dist/server.js`) or, for local
iteration, straight from source — no copy step needed either way.

## Known simplification

`Review` (the persisted `@mstack/core` primitive) does not carry the submitted content
title/type — by design, it's the reviewer's verdict, not a copy of the submission. The portal
caches those two display-only fields in-process, keyed by review id, at submit time
(`src/dashboard.ts`); every review the dashboard can ever list was created by this same
process's `POST /api/review` handler, so the cache is always populated for it. If the server
restarts, a review created in the *prior* process falls back to a placeholder title in the
dashboard — its score/verdict/findings are unaffected (DuckDB is the real system of record for
those). Fixing this durably would mean extending `@mstack/core`'s `Review` schema or adding a
side table to `@mstack/memory`, out of scope for an app that only consumes those packages.

## Config (env)

Same variables as the CLI (`apps/cli`), so both point at the same warehouse by default:

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4310` | HTTP port |
| `ANTHROPIC_API_KEY` | unset | presence selects live vs. offline mode |
| `DATA_DIR` | `./.data` | warehouse + corpus root |
| `DRAFTS_DIR` | `./drafts` | human-glanceable pending-draft files |
| `OUTBOX_DIR` | `./outbox` | where an approved draft "sends" to (a file, not a network call) |
| `LANCE_DIR` | `<DATA_DIR>/lancedb` | reviewer corpus (LanceDB) |

## Testing

`src/server.test.ts` (vitest) builds the Fastify instance directly (`buildServer()`) and drives
it with `fastify.inject()` — no bound port, no network, no `ANTHROPIC_API_KEY` (forced offline,
temp `DATA_DIR`/`DRAFTS_DIR`/`OUTBOX_DIR`/`LANCE_DIR` per test, same pattern as
`apps/cli/src/demo.test.ts`). Covers: submitting the dirty ABC Corp asset → `RETURNED` with all
six finding categories; submitting the clean Northland Analytics asset → `APPROVED`; the
dashboard listing after a submission; approving a draft → `dispatched` + a `sent` outcome; the
INTERNAL ledger tallies; and the static index page.

Per `docs/build-conventions.md`, this is **not run locally** (no local `pnpm install`/build —
the dev tablet OOMs on native deps elsewhere in the workspace) — it runs on Spark as part of
`pnpm install && pnpm -r build && pnpm -r test`.
