# Reusable building blocks (harness-native) — integration surface

The user asked to build on tools we already have. Here's what each provides and how the
marketing-agents stack should wire it.

## Chorus — the federated workflow runtime  (`C:\Users\globa\chorus`, npm `@delightfulchorus/*`)
- **Is**: self-hosted workflow engine. Fires on webhook / cron / manual. Calls SaaS services.
  Self-repairs broken integrations (Claude repair-agent → snapshot-validated → signed patch → canary ladder → fleet).
- **Packages**: `core` (types/Zod/error-signature), `runtime` (exec engine: cron, webhooks, retries, SQLite state),
  `registry` (signed patch registry), `reporter` (failure capture + PII redaction), `repair-agent`, `cli` (`chorus`).
- **Use for**: the durable **decision-loop scheduler** (weekly Account-Intelligence runs) and the **action-dispatch** layer
  (calls CRM/Slack/email). Integrations self-heal when a vendor API drifts — perfect for a GTM stack spanning many SaaS APIs.
- **Wire**: `chorus init` scaffolds `./chorus/`; workflows are TS files with steps. We add marketing workflows + integrations.

## workflow-bridge — role-agent pattern + MCP bridge  (`C:\Users\globa\workflow-bridge`)
- **Is**: Chorus runtime + Claude Code harness. Role agents (bookkeeper/hr/sales) each with agent.yaml + SOUL.md + RULES.md + workflows/.
- **Principles to mirror**: (3) **draft-first for external actions** — all candidate/prospect/customer-facing actions land in a drafts
  folder; a human dispatches. (4) scoped MCP access per role. (5) every step leaves a hash (audit log).
- **Use for**: the template for our **marketing role-agents** (Reviewer, Account-Analyst, Campaigner). Draft-first = the human-in-the-loop gate.
- **MCP server**: exposes `workflow_list/run/status/log` + `connector_resolve`.

## gatecraft — credential broker + settlement  (`C:\Users\globa\gatecraft`, MCP `mcp__gatecraft__*`)
- **Is**: identity, wallet, settlement for AI agents + local-first credential broker (creds never seen in plaintext).
- **MCP tools**: `gc_acquire_credential`, `gc_store_credential`, `gc_proxy_call`, `gc_list_providers`, `gc_plan_acquisition`, `gc_wallet`, ...
- **Use for**: auth to CRM / data warehouse / enrichment APIs without leaking keys into agent context. `gc_proxy_call` makes the
  authed API call on the agent's behalf.

## "LangChain killer" — Claude-native agent orchestration (the harness itself)
- We orchestrate agents natively (Agent tool, sub-agent roster, /go pipeline) — no LangChain runtime.
- `github-langchain-agent/` is a *consumer* of LangChain (a demo), NOT our framework. Our framework = the harness + chorus workflows.
- **Use for**: the agent decision loops are plain TS/Python calling the Anthropic SDK + tool-use, scheduled by chorus — not LangGraph.

## PCC pieces (optional, heavier)
- **PCC agent-package / kernel + VCR** — capability-secure execution with human-approval gates for the *action* layer if we want
  money-path / high-risk actions gated. Overkill for v1; note as the hardening path.

## How they compose into the marketing stack
```
signals ─▶ [chorus trigger: webhook/cron] ─▶ role-agent decision loop (Anthropic SDK + tools)
                                                   │  creds via gatecraft gc_proxy_call
                                                   ▼
                                          decision + draft action ─▶ drafts/ (human dispatch)  [workflow-bridge pattern]
                                                   │
                                                   ▼
                                          outcome ─▶ compounding memory (SQLite/hash-chained log)
```
