# Landscape Research — Marketing Agents in Production

Source event: **Marketing Agents in Production** (Tokens of Growth series), 2026-07-20.
Watch: https://streamyard.com/watch/AskiwbX9NQCh · Event: https://luma.com/vu55gimo

## The two production workflows demonstrated

### 1. Anthropic — Partner/Brand Asset Review at scale (Saqib Mustafa, Head of Partner Marketing)
- **What runs**: Claude automates review of **partner-generated marketing assets** while maintaining brand consistency.
- **Concrete pipeline**: scores each asset **against approved messaging** and **surfaces "claim drift"** (claims that deviate from approved positioning / are unsupported).
- **Context**: tied to the Claude Partner Network ($100M). Saqib previously scaled Snowflake's partner network to 10,000+ partners embedded in 80% of GTM.
- **Buildable primitive**: an agentic **brand/claim-compliance reviewer** — ingest asset (doc/deck/page/image) → extract claims → check against an approved-messaging corpus + claim ledger → score + flag drift + suggest fixes → route for human approval.

### 2. AI-Native Data Platform for Growth — "Account Intelligence" (Guan Wang, ex-Snowflake/Airtable)
- **Thesis slide**: *The Signal-to-Decision Gap* — "today's GTM stack captures customer intent but struggles to convert it into timely action."
- **Framework**: move growth orgs past basic prompt engineering into **deep, multi-signal context engines** pulling from **CRM + product usage + engagement**.
- **Key idea**: build **decision loops that capture compounding organizational knowledge every week** — not dashboards that just get faster to read.
- **Buildable primitive**: an **Account Intelligence engine** — unify multi-signal account context → reason to a decision/brief → emit a timely action → capture the outcome back into a compounding memory.

### Connective thesis (both talks)
Signal → **Decision** → **timely Action** → outcome memory. The industry frames this as the **signal-to-action gap**: teams can *see* who's in-market but can't act fast/coherently enough to convert. Agentic GTM = detect signal → decide next action → execute across CRM/MAP/analytics/outreach without a human triggering each step.

## Existing tools landscape (from awesome-ai-gtm + market scan)

| Layer | Commercial incumbents | Open source / free |
|---|---|---|
| Data & enrichment | Clay (150+ providers), Common Room, Warmly, Persana, Landbase | — (Clay is the de-facto hub) |
| Intent & signals | Unify, UserGems, Amplemarket, Demandbase, Common Room; Profound/Sitefire (AEO) | **GPT Researcher** (20+ web sources) |
| Orchestration / signal→action | **Tapistro**, **Unify**, Demandbase, Regie.ai | — (this is the biggest open gap) |
| AI SDR / outbound agents | 11x, Agentforce SDR, Jeeva, Oneshot, Qualified/Piper | **SalesGPT**, Knotie-AI, SalesCopilot |
| Conversation intelligence | Gong, Chorus (ZoomInfo), Fireflies, Fathom, tl;dv, Otter | Fathom/tl;dv have free tiers |
| Content generation | Jasper, Copy.ai, Writer, Tofu, Autobound, Kana | AI Company Researcher (Bright Data) |
| Lead scoring | MadKudu, Pocus | — |
| Data platform | Snowflake (CoWork), Airtable (AI-native), Databricks | dbt, DuckDB, Postgres |
| Agent frameworks | (proprietary inside each product) | **LangChain/LangGraph, CrewAI, our own langchain-killer, chorus** |

**Curator's note in the list itself:** *"No open-source CRM or developer frameworks appear in this curated list."* → The **developer-framework + orchestration layer for marketing agents is the open gap.** Everything is a closed SaaS point-solution; there is no open, composable "signal→decision→action" runtime you can drop your own models/data into.

## Where the open gap is (preliminary — refine after transcript)
1. **Open asset-review / claim-drift agent** — nobody ships this OSS. Anthropic built it internally. High-value, self-contained, demoable.
2. **Open Account-Intelligence engine** — a multi-signal context compiler + weekly decision loop with compounding memory. Incumbents (Tapistro/Unify) are closed SaaS.
3. **The connective runtime** — a signal-bus → agent-decision → action-dispatch loop with human-in-the-loop gates, that you point at your own CRM/product/data warehouse.

## Our reusable building blocks (harness-native)
- **langchain-killer** — our agent framework (replaces LangChain/LangGraph for the decision loop).
- **chorus** — multi-LLM compose (ensemble reasoning for scoring/decisions).
- **gatecraft** — local-first credential broker (for CRM/data-source auth without leaking keys).
- **federated workflow runtime** (`@pcc/workflow`) — durable execution for the weekly decision loops + long-running action dispatch.
- **PCC agent-package / kernel** — 249-tool capability pack + capability-secure execution (VCR) for the action layer with human-approval gates.

## Speakers / series
- Host: **Rajan Sheth** (ex-CMO Together AI, Cohere, Cline; scaled Heroku $0→$500M+) + **Waqas Makhdum** (dev marketing at Nebius, Snowflake, OpenAI, Dropbox, AWS).
- Series = "Tokens of Growth" — monthly, AI-native marketing, "real workflows, real tools, honest answers about what broke before it worked."

## Sources
- https://luma.com/vu55gimo
- https://github.com/ong/awesome-ai-gtm
- https://www.tapistro.com/blog/from-signal-to-pipeline-tapistro-turns-intent-data-into-action
- https://www.anthropic.com/news/claude-partner-network
- https://www.snowflake.com/en/blog/authors/guan-wang/
