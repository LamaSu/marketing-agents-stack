# Build Orchestration Plan — how this repo gets built (the "meta" layer)

Two agent architectures live in this project:
- **(A) Product agents** — the marketing agents the repo *ships* (run at the user's company).
- **(B) Build agents** — the sub-agents *I* orchestrate to build the repo (Fable → Opus/Sonnet → Sol).

This doc plans both, per the user's routing: *Fable for high-level, Opus+Sonnet to code it via /go, Sol for review/audit.*

---

## (B) Build orchestration — model routing

| Phase | Owner (model) | Job | Inputs |
|---|---|---|---|
| B0 Ground | (done, main/Opus) | transcript + slides + landscape + reusable-tools dossier | video, web |
| B1 **Design** | **Fable** (`fable-synthesist`) | reconcile dossier → reference architecture + build spec + gap map. NON-code synthesis = Fable's documented strength. Opus fallback if it declines. | 01-landscape, 02-reusable-tools, transcript, slides-notes |
| B2 **Code-shape** | **Fable** (`fable-code-architect`) | module boundaries / file layout / interfaces the implementers build to | B1 spec |
| B3 **Build** | **Opus + Sonnet** (`implementer` Ralph-loop, /go-style waves) | write the packages + agents + workflows to the spec | B1 + B2 |
| B4 **Tests** | Sonnet (`test-writer` sidecar) | tests alongside each package | B3 diffs |
| B5 **Review/Audit** | **Sol** (`codex-offload review`) | bug-find + audit the money/action paths + prompt-injection surface | B3 repo |
| B6 Fix | Opus/Sonnet | apply confirmed Sol findings | B5 report |

Why this split (per rules/library/fable-5-routing.md): Fable reasons over sources & designs structure; Opus/Sonnet write the code (Fable's classifiers refuse this operator's security-flavored code, and marketing-agent code touching creds/outreach is security-adjacent). Sol is the independent adversarial reviewer.

### Sub-agent context discipline (per SUBAGENT_RULES)
Every implementer spawn gets: (1) the B1 spec section it owns, (2) the B2 code-shape for its module, (3) the relevant reusable-tool API (chorus/gatecraft), (4) a crisp acceptance test. Draft-first rule injected: **no agent emits a real external action; everything lands in `drafts/`**.

---

## (A) Product agent architecture — DRAFT for Fable to finalize

The two production workflows from the talk, generalized into an open, drop-in stack:

```
        ┌──────────────────── SIGNAL BUS ────────────────────┐
        │ webhooks · cron · CRM/product/engagement pulls      │  (chorus triggers)
        └───────────────┬─────────────────────────────────────┘
                        ▼
        ┌──────────────────── CONTEXT ENGINE ────────────────┐
        │ unify multi-signal account context (CRM + product   │  "Account Intelligence"
        │ usage + engagement) → compounding memory (per week) │  (Guan's framework)
        └───────────────┬─────────────────────────────────────┘
                        ▼
        ┌──────────────────── DECISION AGENTS ───────────────┐
        │  • Account-Intelligence Analyst  → next best action │
        │  • Asset-Review / Claim-Drift reviewer (Anthropic)  │  score vs approved
        │  • Campaign / outreach drafter                      │  messaging; flag drift
        └───────────────┬─────────────────────────────────────┘
                        ▼
        ┌──────────────────── ACTION LAYER (draft-first) ────┐
        │ every candidate action → drafts/ → human dispatch   │  (workflow-bridge pattern)
        │ authed calls via gatecraft gc_proxy_call            │  creds never in context
        └───────────────┬─────────────────────────────────────┘
                        ▼
                   OUTCOME → back into compounding memory (the weekly decision loop)
```

**Three shippable agents (v1):**
1. **Asset-Review Agent** (Saqib/Anthropic) — ingest partner/marketing asset → extract claims → check vs an approved-messaging corpus + claim ledger → score + flag *claim drift* → suggested edits → draft for approval. Self-contained, demoable, unique (no OSS equivalent).
2. **Account-Intelligence Engine** (Guan) — multi-signal context compiler → weekly decision brief per account → next-best-action → compounding memory. Closes the "signal-to-decision gap".
3. **Signal→Action Runtime** (connective) — chorus workflows that fire agents on signals and route actions draft-first, with a hash-chained audit log.

**Drop-in posture:** point it at your CRM + warehouse + messaging corpus; bring your own Claude key; agents + workflows are the code; incumbents (Tapistro/Unify/Clay) are closed SaaS — this is the open, composable alternative.

> This draft is the *starting point* handed to the Fable design pass (B1). Fable owns the final architecture, package split, and the exact agent/loop contracts.
