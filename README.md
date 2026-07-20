# Marketing Agents Stack

**An open, drop-in "marketing agents in production" stack** — the signal → decision →
action → outcome loop, as composable, offline-first, Claude-native TypeScript on your own
runtime. It reproduces the two production workflows demoed in the *Marketing Agents in
Production* webinar (Tokens of Growth) as open source:

1. **Asset-Review / Claim-Drift agent** — submit a partner's marketing asset → it's scored
   1–5 against your approved messaging, with categorized **claim drift** flagged (guaranteed
   outcomes, uncited stats, unapproved superlatives / spokesperson quotes, roadmap leaks,
   badge/tier misuse) and a *recommended change* for each → drafts the partner email + review
   export. **It reviews and tracks; it never writes marketing copy.**
2. **Account-Intelligence engine** — unify multi-signal account context → score it (ML noise
   filter) → an agent swarm (SDR-Researcher · Copywriter · GTM-Router) surfaces the relevant
   signals + *why*, resolves the buying committee, picks the next-best action, and drafts
   personalized outreach → **a human approves before anything sends**.

> The incumbents that do this — Tapistro, Unify, Clay, MadKudu, Snowflake + paid ML — are
> closed SaaS point-solutions. There is no open, composable "signal → decision → action"
> runtime you point at *your own* data and models. **This is that.**

## The loop

```
 SIGNAL ─▶ CONTEXT ENGINE ─▶ DECIDE ─▶ ACT (draft-first) ─▶ OUTCOME ─▶ (compounds back)
 SignalSource   unify + enrich   score+swarm   drafts/ + HUMAN APPROVAL   memory + audit
 (sample|posthog (sample|llm-web  (Rules+Claude  gatecraft-brokered send   DuckDB + hash-
 |github|segment  |wikidata|...)   +ONNX; SDR/    ONLY after an Approval    chained ledger
 |sql)                             Copy/Router)
                       Foundation: Trusted Data · Shared Memory · Governance · Feedback Learning
```

Both webinar demos are two halves of **one** loop — Saqib's Portal specializes it to
brand-safe content governance; Guan's SignalSphere specializes it to account activation.
They share the same primitives, memory, draft-first gate, and runtime.

## Three guardrails — mechanical, not aspirational

Each is enforced by the type system / a state machine, because the speakers learned them the hard way:

1. **Reviewer ≠ generator.** `ReviewResult` has *no field* for generated marketing prose; a
   finding's `recommendedChange` is a short instruction. Enforced by a test. *(Saqib: "it's a
   reviewer and a tracker, not a content generator.")*
2. **A human approves every send.** No adapter exposes a direct-send method. A `Draft` reaches
   `dispatched` only through `runtime/dispatch.ts` + a matching **approved** `Approval` row.
   *(Guan: "humans still stay in the loop before any message goes out.")*
3. **Keep every record.** Every workflow writes to `@mstack/memory` ≥ twice (raw in,
   decision/outcome out); the loop compounds. *(Guan's #1 lesson: "my AI is lying to me because
   it didn't have the context.")*

## Packages

| Package | Responsibility |
|---|---|
| `@mstack/core` | Domain Zod schemas, the 5 adapter seams, model map, audit-hash utils |
| `@mstack/memory` | DuckDB compounding warehouse + hash-chained approval audit |
| `@mstack/agents` | Claude-native `runAgent` (tool-use loop + Zod re-ask) — no LangChain |
| `@mstack/reviewer` | Asset-Review / Claim-Drift agent: RAG corpus + deterministic rules + Claude judge |
| `@mstack/account-intel` | Account-Intelligence engine + the SDR/Copywriter/Router swarm |
| `@mstack/adapters-signals` | `SignalSource`: sample · segment-webhook · posthog · github · sql |
| `@mstack/adapters-enrichment` | `EnrichmentProvider`: sample · llm-web (Claude) · wikidata/gleif/edgar |
| `@mstack/adapters-scoring` | `ScoringProvider`: Rules + Claude-cold-start + ONNX → Hybrid |
| `@mstack/credentials` | gatecraft credential-broker boundary (keys never enter agent context) |
| `@mstack/runtime` | chorus workflows + the draft-first dispatch queue |
| `apps/cli` (`mstack`) | the offline demo driver |

## Quickstart — the 5-minute offline demo (no credentials)

```bash
pnpm install
pnpm mstack seed     # loads sample signals + accounts + north-star corpus into DuckDB + LanceDB
pnpm mstack demo     # runs BOTH workflows end-to-end on sample data:
                     #   content-review  → Reviews + partner-email drafts (RETURNED/APPROVED)
                     #   account-activation → Decisions + outreach drafts (pending approval)
ls drafts/           # every candidate action sits here, status:pending — NOTHING was sent
```

With no `ANTHROPIC_API_KEY`, the demo runs the deterministic + rules + fixture path so the
wiring is provable at zero cost. Set the key and the same command uses live Claude for
extraction, judgment, scoring, and copy. **Bring your own Claude key; everything else is optional.**

## Drop-in integration

Every external dependency is an adapter seam with a `sample` default; going live = register a
real provider. Point `SignalSource` at PostHog / a Segment-spec webhook / your warehouse; drop
your approved-messaging docs into the `GuidelineCorpus`; enable the `llm-web` enricher (Claude +
web) instead of a paid vendor; swap DuckDB → Postgres/Snowflake behind the same `memory`
interface. Keys are brokered by gatecraft — providers never read `process.env`.

## Built on

- **[chorus](https://github.com/LamaSu/federated-workflow-runtime)** — the self-hosted workflow runtime (triggers, retries, self-healing integrations).
- **gatecraft** — local-first credential broker.
- **Anthropic SDK + tool-use** — Claude-native agents; no LangChain/LangGraph.

## Provenance

Inspired by the *Marketing Agents in Production* session of the **Tokens of Growth** series
(Saqib Mustafa, Anthropic; Guan Wang, ex-Snowflake/Airtable; hosts Rajan Sheth & Waqas
Makhdum). The demos there were illustrative rebuilds of internal/proprietary systems; this
repo is an independent, open, offline-first implementation of the *pattern* — not a copy of
anyone's internal tool. Design notes: `research/06-architecture.md`.

## License

MIT.
