# Getting started

An open, offline-first, Claude-native **GTM loop**: signals come in, accounts get scored,
content gets reviewed, outreach gets drafted — and **a human approves every send**.

It runs **keyless and offline out of the box** (no API key, no network, no cloud), and every
external service is an opt-in swap behind a seam. In the decision layer it covers the jobs you'd
otherwise buy from MadKudu (scoring), ZoomInfo (enrichment orchestration), and Outreach
(sequencing) — see [`what-could-be-better.md`](./what-could-be-better.md) for the honest gaps.

---

## 1. Prerequisites

- **Node 22+** and **pnpm 9+** (`corepack enable` gives you pnpm)
- ~2 GB RAM for the build (native deps: duckdb, lancedb, onnxruntime)
- **No API key required.** Set `ANTHROPIC_API_KEY` only if you want the live Claude agents;
  everything below runs deterministic + offline without it.

## 2. Install

```bash
git clone https://github.com/LamaSu/marketing-agents-stack
cd marketing-agents-stack
pnpm install
pnpm -r build
```

## 3. The five-minute tour

```bash
cd apps/cli

node dist/cli.js seed     # load the offline fixtures (signals, guidelines, corpus)
node dist/cli.js demo     # run the whole loop, offline
```

`demo` runs both workflows and prints what happened:

- **CONTENT-REVIEW** — four partner assets reviewed for claim drift. Each gets a verdict
  (`APPROVED` / `RETURNED`), a 1–5 score, and categorized findings
  (`guaranteed_outcome`, `uncited_quantitative`, `badge_tier_misuse`, …).
- **ACCOUNT-ACTIVATION** — signals → score → decision → a drafted outreach email, with the
  buying committee and a next-best action.
- **DRAFTS AWAITING APPROVAL** — everything the run produced, all `pending`.
- **OUTBOX: EMPTY (0 dispatched)** — *nothing was sent.* That's the point.

Now close the loop yourself:

```bash
node dist/cli.js list                       # see the pending drafts
node dist/cli.js approve <draftId>          # the ONLY way anything sends
ls ../../outbox                             # the dispatched message lands here
```

Then look at what the loop learned:

```bash
node dist/cli.js report            # the GTM funnel + conversion by tier + review outcomes
node dist/cli.js ingest-outcomes   # pull the sample return-leg (replies/meetings) in
node dist/cli.js train-qualifier   # approvals + outcomes become training labels
```

### Other commands

| Command | What it does |
|---|---|
| `review <file>` | run the claim-drift reviewer over a content file |
| `score <domain>` | score a single account |
| `sequence start\|tick\|list` | the multi-step cadence engine (queues drafts; never auto-sends) |
| `export-audit --format halo` | export the hash-chained approval ledger for external verification |

## 4. The three surfaces

- **CLI** — `mstack` (above). The whole loop is operable from here.
- **Console** (ops/observability): `cd apps/console && PORT=4320 node dist/server.js` →
  <http://localhost:4320> — the funnel, accounts, signals ledger, draft gate-cards.
- **Portal** (the approval bench): `cd apps/portal && PORT=4321 node dist/server.js` →
  <http://localhost:4321> — review partner assets, see findings, approve/reject with an
  arm→confirm gate.

Both auto-seed on first boot and serve a self-contained offline UI (no CDN, no framework).

## 5. The one thing that makes it different

**A human approves every send.** A `Draft` reaches `dispatched` only through
`runtime/dispatch.ts#dispatchDraft`, which requires a matching **approved**, hash-chained
`Approval` that is **bound to the draft's content** (approve X, and X is what sends — a
post-approval edit is refused), claimed **win-once** so a retry or a race can't double-send.
The reviewer *structurally cannot* write marketing copy (`ReviewResult` has no prose field).
Read the honest threat model + residuals in [`SECURITY.md`](./SECURITY.md).

## 6. Offline by default, SOTA when you want it

Every external service sits behind a seam with an offline default — turning one on changes
nothing structurally:

| Seam | Offline default | Opt-in upgrade |
|---|---|---|
| `FetchSite` (enrichment) | plain fetch + tag-strip | **Crawl4AI** sidecar (JS rendering), **Firecrawl** (hosted) |
| `OutreachChannel` | local outbox (writes a file) | **Composio** (1000+ apps) — still gated by the Approval |
| agent tools | signal-bound SDR researcher | **GPT-Researcher** deep-research sidecar |
| `RecallProvider` | none (warehouse SQL) | **Graphiti** temporal-graph recall |
| `ApproverNotifier` | the portal UI | **HumanLayer** (Slack/email doorbell) |
| `Executor` | in-process | **Hatchet** (durable, crash-resume) |
| `CredentialBroker` | `LocalBroker` | **gatecraft** proxy + DPoP-bound creds |

Each has a `docker/*.md` with the run command and the exact contract. The keyless demo never
needs any of them.

## 7. Walkthrough videos

Short animated explainers under [`../videos/`](../videos/):

| Video | What it walks through |
|---|---|
| `01-quickstart` | zero → a closed loop in five commands |
| `02-the-gate` | why nothing sends without you (the approval gate, end to end) |
| `03-seams` | offline-first + how an opt-in swap works |
| `04-scoring-and-learning` | hybrid scoring, calibration, and approvals-become-labels |
| `05-sequences-and-analytics` | the cadence engine + the funnel report |

Plus the original three: `marketing-agents-loop` (the loop), `subsystem-rundown` (each
package), `stack-blueprint` (contract-level).

## 8. Where to look next

- [`build-conventions.md`](./build-conventions.md) — the three mechanical guardrails + house rules
- [`SECURITY.md`](./SECURITY.md) — threat model, what's guaranteed, what isn't
- [`what-could-be-better.md`](./what-could-be-better.md) — the honest critique
- [`ui-design-brief.md`](./ui-design-brief.md) — the console/portal design system
