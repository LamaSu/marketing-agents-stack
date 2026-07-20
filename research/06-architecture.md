# 06 — Reference Architecture & Build Spec: "Marketing Agents in Production" (open, drop-in stack)

**Status:** implementation-ready. This is the build contract a `/go` run (Opus + Sonnet implementers) codes to.
**Author:** fable-synthesist (design pass B1) · **Date:** 2026-07-20
**Reconciles:** the full webinar transcript (`research/source/transcript/audio16k.txt`), the reconstructed demos (`04-slides-and-demos.md`), the landscape (`01`), the reusable-tools survey (`02`), the build plan (`03`), and the four locked tool-decision files (`tools/A,B,C,D`).

**The one-sentence thesis:** the two demos are two halves of ONE loop — **signal → decision → action → outcome-memory** — and this stack ships that loop as composable, offline-first, Claude-native TypeScript on our own runtime (chorus + gatecraft + the workflow-bridge draft-first pattern), where *incumbents (Tapistro / Unify / Clay / MadKudu / Snowflake+paid-ML) are closed SaaS point-solutions and there is no open, composable alternative.*

**Three non-negotiables that shape every decision below** (all three are stated verbatim by the speakers):
1. **Reviewer ≠ generator.** Saqib: *"this tool ... is not a content generator. It's a content reviewer ... a reviewer and a tracker."* The reviewer's schema literally cannot emit publishable marketing copy.
2. **Human approves every send.** Both demos land candidate actions in a draft state; a human dispatches. Guan: *"humans still stay in the loop before any message goes out."*
3. **Keep every record — the data foundation is the moat.** Guan's #1 lesson: *"my AI is lying to me because it didn't have the context."* Every signal/decision/draft/approval/outcome persists and compounds.

---

## 1. Reference architecture

### 1.1 The signal → decision → action loop (one diagram)

```
   ┌──────────────────────────────── SIGNAL ────────────────────────────────┐
   │  SignalSource seam  (default = SampleSource over signals.sample.jsonl)   │
   │  ├ product_usage (PostHog)   ├ crm (SQL/warehouse)                       │
   │  ├ campaign (Segment webhook)├ intent (GitHub/HN)   ─── zod-validated ──▶│
   └───────────────────────────────────┬─────────────────────────────────────┘
                                        ▼   chorus trigger (webhook · cron · manual)
   ┌──────────────────────── CONTEXT ENGINE (packages/account-intel) ─────────┐
   │  unify signals → Account context   ·  EnrichmentProvider seam            │
   │  (sample | llm-web=Crawl4AI+Claude | wikidata/gleif/edgar | techdetect)  │
   │  writes every raw signal + resolved account → COMPOUNDING MEMORY (DuckDB) │
   └───────────────────────────────────┬─────────────────────────────────────┘
                                        ▼
   ┌──────────────────────── DECIDE ──────────────────────────────────────────┐
   │  ScoringProvider seam (HybridScorer: Rules + Claude-cold-start + ONNX)    │   ◀── NOISE FILTER
   │      "Figma 76/100" — score is a filter, not the answer                   │       (Guan pillar 1)
   │  Agentic swarm (Claude-native, tight-scoped sub-agents):                  │   ◀── REASONING
   │      SDR-Researcher → relevant signals + WHY                              │       (Guan pillar 2)
   │      Copywriter     → personalized draft from committee timeline          │
   │      GTM-Router      → next-best-action + channel + buying committee      │
   │  ── OR ──  Asset-Review / Claim-Drift reviewer (Saqib) ──────────────────┐│
   │      corpus RAG (LanceDB) + deterministic rule layer → 1-5 + findings[]  ││
   └───────────────────────────────────┬──────────────────────────────────────┘
                                        ▼   every candidate action is a DRAFT
   ┌──────────────────────── ACT — DRAFT-FIRST (workflow-bridge pattern) ──────┐
   │  drafts/  (partner email · outreach email · annotated review export)      │
   │           status = pending → ▶ HUMAN APPROVAL GATE ◀ → approve|reject|edit │
   │  on approve: dispatch via gatecraft gc_proxy_call (creds never in context)│
   │  (autopilot = opt-in auto-approve policy, scoped to low-tier, still logged)│
   └───────────────────────────────────┬──────────────────────────────────────┘
                                        ▼
   ┌──────────────────────── OUTCOME → COMPOUNDING MEMORY ─────────────────────┐
   │  hash-chained audit (approvals/actions) + Outcome rows (sent/reply/publish)│   ◀── CLOSED LOOP
   │  feeds the next run's context + the ledger/dashboards. The loop compounds. │       (Guan pillar 3)
   └───────────────────────────────────────────────────────────────────────────┘
        Foundation bar:  Trusted Data · Shared Memory · Governance · Feedback Learning
```

**Why one loop, not two products:** Saqib's Portal is the loop specialized to *outbound brand-safe governance* (the "action" is publishing partner content, the "signal" is a submitted asset, the "decision" is a claim-drift review). Guan's SignalSphere is the loop specialized to *inbound→outbound account activation*. They share the same primitives, the same memory, the same draft-first gate, and the same runtime. Building them as one substrate with two entry-workflows is what makes this a *stack* rather than two demos.

### 1.2 Shared domain primitives (the vocabulary everything speaks)

All primitives are **Zod schemas in `packages/core`**. Key fields only (full schemas are the Wave-1 deliverable). WHY Zod: the tool research (C, A) converges on it — one schema library validates inbound webhooks, agent structured-output, and persistence, in-process, no Python.

| Primitive | Purpose | Key fields |
|---|---|---|
| **Signal** | one normalized event (the ingest atom; Segment-spec-shaped) | `id, ts, source, kind('product_usage'|'crm'|'campaign'|'intent'|'identify'), actor{userId?,anonId?,email?,company?,handle?}, action?, traits?, properties?, raw?` |
| **Account** | a resolved company + its rolled-up context | `id, domain, name, firmographic{employees,industry,region,tech[]}, provenance{field→source}, signalRefs[], score?, tier?, lifecycleStage?, buyingCommittee[], lastScoredAt` |
| **Claim** | an atomic check-worthy assertion pulled from an asset | `id, assetId, text, span{start,end}, category, checkWorthy(bool), extractedBy` |
| **Guideline** | one entry of the north-star corpus / rule-set | `id, category, type('lexicon'|'allowlist'|'denylist'|'approved_messaging'|'tier_map'), content, severity, source, version, embeddingId?` |
| **Finding** | one categorized claim-drift / brand violation | `id, reviewId, claimId?, category(enum,6), required(bool), quote, span?, recommendedChange, supportingPassageId(string|null), detectedBy('deterministic'|'claude'|'nli'), severity` |
| **Review** | the reviewer's verdict on one asset | `id, assetId, partnerId, partnerTier, score(1-5), changesCount, verdict('APPROVED'|'RETURNED'), findings[], draftedEmailId?, exportRefs{word?,gdocs?}, status, createdAt` |
| **Decision** | the account-intel brief (next-best-action) | `id, accountId, ts, score, tier, relevantSignals[{signalId,why}], buyingCommittee[], nextBestAction{action,channel,targetMember}, rationale, byAgent, mode('copilot'|'autopilot')` |
| **Draft** | a candidate external action, never auto-sent | `id, kind('partner_email'|'outreach_email'|'review_export'), refId(account|partner|review), subject?, body, channel, status('pending'|'approved'|'rejected'|'dispatched'), createdBy, createdAt` |
| **Approval** | one HITL decision, hash-chained | `id, draftId?|reviewId?, decision('approve'|'reject'|'edit'), actor, note?, ts, prevHash, hash` |
| **Outcome** | closed-loop result of an action | `id, refType('draft'|'decision'|'review'), refId, result('sent'|'replied'|'meeting'|'published'|'returned'|'no_response'), metrics?, ts` |

**Two invariants encoded in the types (this is where the guardrails become mechanical, not hopeful):**
- `Finding.recommendedChange` is a *targeted instruction* ("cite the study or remove the figure"), and there is **no field anywhere in `Review` for generated marketing prose**. The reviewer physically cannot return publishable content — guardrail #1 is a type, not a prompt suggestion.
- Every externally-directed action is a `Draft` whose only path to `dispatched` is through an `Approval` row. No adapter exposes a direct-send call. Guardrail #2 is a state machine, not a convention.

---

## 2. Monorepo layout

pnpm workspaces + turbo (already scaffolded). TypeScript + ESM everywhere. Python appears **only** as an optional offline ML-training sidecar (Wave 5, `packages/adapters-scoring/train/`). MIT throughout. One-line responsibility each:

```
marketing-agents-stack/
├─ packages/
│  ├─ core/                 # domain Zod schemas + the 5 adapter-seam interfaces + model-id map + constants
│  ├─ memory/               # compounding warehouse: DuckDB repo (@duckdb/node-api) + hash-chained audit + dbt models
│  ├─ agents/               # Claude-native agent runtime: Anthropic SDK wrapper, tool-use loop, Zod-reask, context-pack builder, model router
│  ├─ reviewer/             # Asset-Review / Claim-Drift agent (Saqib): corpus RAG + deterministic rules + guideline-authoring helper
│  ├─ account-intel/        # Account-Intelligence engine (Guan): context engine + swarm (SDR-Researcher/Copywriter/GTM-Router)
│  ├─ adapters-signals/     # SignalSource impls: sample(default), segment-webhook, posthog, github, sql-warehouse
│  ├─ adapters-enrichment/  # EnrichmentProvider impls: sample, llm-web(Crawl4AI+Claude), wikidata, gleif, edgar, techdetect, email, + opt-in stubs
│  ├─ adapters-scoring/     # ScoringProvider impls: rules, claude, onnx, hybrid (+ /train Python sidecar)
│  ├─ runtime/              # chorus wiring: workflow defs, draft-first dispatch queue, gatecraft-brokered outreach channels
│  └─ credentials/          # gatecraft wrapper: gc_proxy_call helper + provider registry (creds never touch agent context)
├─ apps/
│  ├─ portal/               # Partner Content Portal (Saqib): Submit Content · Review Dashboard · INTERNAL tabs
│  ├─ console/              # SignalSphere Autonomous Activation Console (Guan): stream · scoring · swarm · resolution studio · Copilot↔Autopilot
│  └─ cli/                  # `mstack` — the offline demo driver (seed · demo · review · score · approve)
├─ data/
│  ├─ signals.sample.jsonl  # bundled offline signals (product_usage+crm+campaign+intent rows)
│  ├─ accounts.sample.json  # bundled offline enrichment fixtures (~20-50 companies+contacts)
│  └─ corpus/               # sample approved-messaging + brand rule-set (the demo's north star)
└─ chorus/                  # `chorus init` output: workflow registration, SQLite exec-state, integrations
```

**WHY this split:**
- `core` has zero runtime deps (just `zod`) so every other package and both apps import the same types — the primitives never fork.
- `memory` is its own package because the transcript's #1 lesson is *the data foundation is the point*. It owns the DuckDB warehouse (compounding data) and the hash-chained audit (governance). It is deliberately not folded into `runtime`.
- `agents` vs `reviewer`/`account-intel`: `agents` is the *mechanism* (how you call Claude with tools + Zod + a context pack + model routing); `reviewer` and `account-intel` are the two *products* built on it. This is what lets a team "start small" (ship just `reviewer`) then extend to the hub.
- `adapters-*` are separate packages so a user swaps `sample` → real by installing one and registering it — nothing downstream changes. This is the offline-first / drop-in seam made physical.
- `credentials` is separate from `runtime` so the "creds never in agent context" boundary is a package boundary you can audit in one place.

**State-store split (reconciled from the constraints + tool file D):** chorus's SQLite holds **workflow execution state** (runs, retries, self-heal). The `memory` package's **DuckDB** file is the **compounding data foundation** (all domain primitives, for analytics + scoring + history). The **hash-chained audit** is an append-only table in `memory`. DuckDB is single-writer, so *all* domain writes route through `memory` (invoked from serialized chorus steps + the apps via `runtime`) — never direct concurrent writes. When concurrency outgrows that, swap the system-of-record to Postgres (`pg`) behind the same `memory` repository interface, keeping DuckDB as the analytics engine (exactly D's guidance; no rewrite).

---

## 3. The shippable agents (schemas · prompt shape · context pack · draft-first action)

This section doubles as the **"how to build the agents / what to prompt / what context to give"** answer. Every agent is a plain TypeScript function in `packages/agents` calling the Anthropic SDK with tool-use and a **Zod-validated structured output** (one bounded re-ask on parse failure). No LangChain. The *context pack* — what goes into the model's context — is called out explicitly for each, because the transcript's core lesson is that context quality, not model choice, is the differentiator.

### 3.0 Shared agent mechanism (`packages/agents`)

```ts
// The one call every agent makes. Model routing is per-agent (see the map below).
async function runAgent<TIn, TOut>(cfg: {
  model: string;                       // from core/model-map
  system: string;                      // tight-scoped instruction (job-as-function, not identity)
  input: TIn;                          // validated by an inbound Zod schema
  outSchema: z.ZodType<TOut>;          // structured output contract
  tools?: Tool[];                      // Claude tool-use: retrieve(), sqlQuery(), enrich(), ...
  contextPack: ContextBlock[];         // the retrieved evidence — THE lever
}): Promise<TOut>
```

**Model-id map (`core`), per the task's product-agent routing:**
- `claude-opus-4-8` → **reviewer judge** (correctness on brand/legal-adjacent findings is worth the premium).
- `claude-sonnet-5` → **SDR-Researcher, Copywriter, guideline-authoring** (reasoning over signals + copy).
- `claude-haiku-4-5-20251001` → **GTM-Router, deterministic-assist classification, per-account score assists** (cheap, high-volume).

**Prompt hygiene (harness policy, and it measurably matters):** every `system` prompt is **job-as-function**, not identity inflation ("You produce X" not "You are an elite Y"). No panic framing, no harsh adverbs. This is not cosmetic — the emotion-vector work shows identity/panic framings causally raise misaligned output; a compliance reviewer is exactly where you want the calm baseline.

---

### 3.1 Agent A — Asset-Review / Claim-Drift Reviewer (`packages/reviewer`)

**Purpose:** given a partner marketing asset + the approved partner-content guidelines (the north star), find claim-drift and brand-rule violations, categorize each with a recommended change, score 1–5 on the rubric, and draft the partner-facing email + annotated export. **It reviews and tracks; it never generates content.**

**Input schema:**
```ts
const ReviewRequest = z.object({
  partnerId: z.string(),
  partnerTier: z.enum(["Select","Elite","Registered"]),   // drives badge/tier check
  contentTitle: z.string(),
  contentType: z.enum(["blog","press_release","case_study","social","email","landing_page","other"]),
  content: z.string(),                                     // the asset text (or extracted text of a doc)
});
```

**Output schema** (the whole point — machine-checkable, diffable, gradeable):
```ts
const Finding = z.object({
  category: z.enum([
    "guaranteed_outcome","uncited_quantitative","unapproved_superlative",
    "unapproved_spokesperson_quote","roadmap_disclosure","badge_tier_misuse"]),
  required: z.boolean(),                       // REQUIRED tag from the demo
  quote: z.string(),                           // offending text, verbatim
  span: z.object({ start: z.number(), end: z.number() }).optional(),
  recommendedChange: z.string(),               // a targeted instruction, NOT drafted prose
  supportingPassageId: z.string().nullable(),  // approved-corpus evidence id, or null = unsupported
  detectedBy: z.enum(["deterministic","claude","nli"]),
  severity: z.enum(["low","medium","high"]),
});
const ReviewResult = z.object({
  score: z.number().int().min(1).max(5),       // 5=publish … 1=needs a lot of work
  changesCount: z.number().int(),              // maps to the rubric (0→5, 1-2→4, 3→3, 4→2, 5+→1)
  verdict: z.enum(["APPROVED","RETURNED"]),
  findings: z.array(Finding),
  summary: z.string(),                         // one-paragraph reviewer note (not content)
});
```

**System-prompt sketch (tight-scoped — the reviewer≠generator rule lives here AND in the schema):**
> You are a partner-content **compliance reviewer**. Your only job: compare a submitted asset against the approved partner-content guidelines (your north star) and report where it drifts. You do **not** write, rewrite, expand, or generate marketing content. A "recommended change" is a short instruction to the partner (e.g. *"cite a published source for this figure or remove it"*), never a drafted replacement paragraph.
> Use the provided guideline rules and the retrieved approved-messaging passages. For each check-worthy claim decide: is it supported by a retrieved passage (cite its id) or unsupported (null)? Categorize every violation into exactly one of the six categories. Score 1–5 strictly by the rubric based on the number of required changes. Return **only** the JSON matching the schema. The deterministic pre-scan findings supplied in context are high-confidence — include them unless clearly wrong.

**Context pack (this is the differentiator — build it in `packages/reviewer`):**
1. The asset text, segmented into spans.
2. `partnerTier` + the **tier→badge map** (Guideline `type:tier_map`) so badge/tier misuse is checkable.
3. Per claim: **top-k approved-messaging passages** retrieved from **LanceDB** (embedded with `bge-small-en-v1.5` via `@xenova/transformers`) — this answers "is this claim supported?".
4. The **brand rule-set**: guarantee-word lexicon, banned-superlative lexicon, spokesperson **allowlist** + approved-quote corpus, roadmap/codename **deny-list** (Guideline rows `type: lexicon|allowlist|denylist`).
5. The **deterministic pre-scan results** as priors (see pipeline below) — mechanical categories never depend on model mood.
6. The rubric.

**Reviewer pipeline (per asset)** — implements C's FacTool-5-stage shape, live path all TypeScript:
1. **Ingest & segment** (TS) → text + spans.
2. **Deterministic pre-scan** (TS, model-independent): lexicon/regex for guarantee words, banned superlatives, badge/tier strings, roadmap/codename deny-list; `gitleaks` pass for secret leakage. Each hit → candidate `Finding{detectedBy:'deterministic'}`.
3. **Claim extraction** (Claude/Sonnet, Zod): extract atomic claims, tag `category` + `checkWorthy`.
4. **Retrieve** (TS): per check-worthy claim, embed + pull top-k from LanceDB; match quotes against the approved-quote corpus, spokespeople against the allowlist.
5. **Judge & ground** (Claude/**Opus-4-8**, Zod): with passages + rules in context, per claim → `supported|drifted|unsupported`, set `severity`, cite `supportingPassageId` or null, write `recommendedChange`. Merge in the step-2 priors.
6. **Score & emit** (Claude, Zod): fill the rubric → `score`, `changesCount`, `verdict`, `findings[]`. Zod parse failure → one bounded re-ask.
7. *(phase-2, opt-in Python sidecar)* **NLI backstop**: MiniCheck / DeBERTa-NLI over (claim, top-k) for every "unsupported/drifted" claim; disagreement with Claude → `detectedBy:'nli'` + `needs_review`. Model-independent audit evidence.

**Draft-first action:** on completion the reviewer produces a `Draft{kind:'partner_email'}` (the partner-facing email) + a `Draft{kind:'review_export'}` (annotated Word/GDocs review). **Both land in `drafts/` with `status:pending`.** A human in the portal dispatches. The `Review` row (verdict RETURNED/APPROVED, findings, links) is written to `memory` and shows in the Review Dashboard + INTERNAL ledger.

**Guideline-authoring helper (in scope — Saqib built the guidelines *with Claude* "in two minutes"):** `reviewer/authorGuidelines(brandBrief) → Guideline[]`. A Sonnet call that turns a short brand brief into the initial corpus: the six-category rule-set (lexicons/allowlists/deny-list/tier-map) + a starter approved-messaging set, emitted as Zod `Guideline[]` and loaded into LanceDB + the rule tables. This is the "Claude writes the initial guidelines too" requirement, and it's what makes the stack usable on day one before a real corpus exists.

---

### 3.2 Agent B — Account-Intelligence engine + swarm (`packages/account-intel`)

**Purpose:** ingest the multi-signal account stream, score it as a noise filter, then run a tight-scoped agent swarm that surfaces the per-account relevant signals + why, resolves the buying committee, picks the next-best-action, and drafts personalized outreach — landing everything in the draft-first gate. Compounds into memory.

**Input schema:**
```ts
const ActivateAccount = z.object({
  accountRef: z.object({ domain: z.string(), name: z.string().optional() }),
  window: z.object({ since: z.string() }).optional(),      // signal lookback
  mode: z.enum(["copilot","autopilot"]).default("copilot"),// autopilot only honored for low-tier
});
```

**Output schema — the decision brief:**
```ts
const CommitteeMember = z.object({
  name: z.string(), role: z.string(),
  persona: z.enum(["Engineering","Product","Security","Marketing","Exec","Other"]),
  influence: z.string().optional(),                        // "Key Technical Influence"
});
const AccountDecision = z.object({
  account: z.object({ domain: z.string(), name: z.string() }),
  score: z.number().min(0).max(100),                       // "Figma 76/100"
  tier: z.enum(["STRONG_FIT","FIT","PARTIAL_FIT","DISQUALIFIED"]),
  relevantSignals: z.array(z.object({ signalId: z.string(), why: z.string() })), // signal + WHY
  buyingCommittee: z.array(CommitteeMember),
  nextBestAction: z.object({ action: z.string(), channel: z.string(), targetMember: z.string() }),
  rationale: z.string(),
});
```

**The swarm — three tight-scoped Claude sub-agents (each a `runAgent` call, each its own schema):**

| Worker | Model | Job (tight scope) | Reads (context pack) | Emits |
|---|---|---|---|---|
| **SDR-Researcher** | sonnet-5 | Surface the signals relevant to THIS account and say *why* each matters. No outreach, no scoring. | account's `Signal[]` from `memory` (DuckDB query tool) + enrichment record (`EnrichmentProvider`) | `relevantSignals[{signalId,why}]` + `buyingCommittee[]` draft |
| **Copywriter** | sonnet-5 | Draft ONE personalized message from the committee timeline + rationale. No sending, no routing. | committee + `relevantSignals` + multi-touch timeline + brand voice note | `Draft{kind:'outreach_email'}` body+subject |
| **GTM-Router** | haiku-4-5 | Pick next-best-action + channel + which committee member. Classify only. | committee + score/tier + `relevantSignals` | `nextBestAction{action,channel,targetMember}` |

**SDR-Researcher system-prompt sketch:**
> You produce an account signal brief. Given one account's raw signals and enrichment, output the subset of signals that matter for a sales conversation and, for each, one sentence on why it matters now. Also resolve the likely buying committee (name, role, persona). You do not write outreach and you do not send anything. Return only the JSON schema. Cite `signalId`s that actually appear in the input — never invent a signal. If signals conflict, say so in the `why` rather than averaging them.

(The "never invent a signal / cite real ids" clause is the direct fix for Guan's Q&A worry about conflicting/hallucinated context and the transcript's "my AI is lying because it lacked context" — the agent is bound to the persisted signal rows.)

**Scoring as the noise filter (before the swarm):** the engine calls the **`ScoringProvider`** (default `HybridScorer`) to rank accounts; only the top-N get the (more expensive) swarm. This is Guan's pillar-1 explicitly: *"machine learning becomes an engine that can help you remove ... the noise."* Default `ClaudeScorer` gives a cold-start score **with a rationale** (no training data needed); `OnnxScorer` (scikit-learn→ONNX, in-TS) activates once labeled conversions exist; `RulesScorer` is the always-on floor + hard disqualifiers.

**Draft-first action:** the Copywriter's message is a `Draft{kind:'outreach_email', status:'pending'}`. In **copilot** mode a human approves in the console before dispatch. In **autopilot** mode (opt-in, scoped to low-tier/SMB accounts per Guan) an explicit auto-approve policy writes the `Approval` row automatically — *still logged, still hash-chained, never for strategic/VIP accounts.* Dispatch is always via `gatecraft gc_proxy_call`.

**Context-pack discipline (the meta-answer):** the swarm never sees raw pages or the whole warehouse — it sees the *normalized, persisted* `Signal[]`/`Account` for one account plus a merged enrichment record with **per-field provenance**. The merge trust order is `registry(CC0) > llm-web > paid` (from tool file B), so the agent can cite where each fact came from and conflicting sources are resolved by trust, not averaged. This is the concrete implementation of "invest in the data foundation."

---

### 3.3 The connective runtime (`packages/runtime` + `chorus/`)

**Purpose:** fire the agents on signals, enforce the draft-first gate, broker credentials, and write everything to compounding memory — durably, with retries and self-healing, on chorus.

- **Triggers:** chorus webhook (portal submit, Segment events), cron (weekly account-activation), manual (CLI). 
- **Draft-first dispatch queue:** a `runtime/dispatch.ts` that is the ONLY code path to an external send, and it refuses any `Draft` without a matching `approved` `Approval`. This is the workflow-bridge pattern reproduced (draft-first + scoped access + hash-chained audit), not imported.
- **gatecraft brokering:** `packages/credentials` wraps `gc_proxy_call`; outreach channels + enrichment/CRM keys are resolved at call time, logged (telemetry only), and never enter agent context.
- **Self-healing:** chorus's repair-agent handles vendor-API drift on the real connectors — the reason a GTM stack spanning many SaaS APIs wants chorus rather than raw cron.

---

## 4. Workflows as chorus definitions

Both are TS files under `chorus/` registered with the runtime. Each has the **explicit HITL approval step** and the **write-to-compounding-memory step** called out (they are mandatory, not optional).

### 4.1 `content-review` workflow

```
trigger:  webhook POST /workflows/content-review   (portal "Submit for review")  |  manual (cli)
steps:
  1. ingest         → validate ReviewRequest (zod); persist raw asset to memory
  2. pre_scan       → reviewer deterministic layer (lexicons/regex/gitleaks) → candidate findings
  3. review         → reviewer agent (extract → retrieve[LanceDB] → judge[Opus] → score) → ReviewResult
  4. persist_review → WRITE Review + Findings to COMPOUNDING MEMORY (DuckDB); update INTERNAL ledger
  5. draft          → build Draft(partner_email) + Draft(review_export word/gdocs) → drafts/ (status:pending)
  6. HITL_APPROVAL  → ⛔ human reviews in portal → approve|edit|reject  (writes hash-chained Approval)
  7. on_approve     → dispatch email via gatecraft; set verdict RETURNED/APPROVED; WRITE Outcome → MEMORY
retries:  steps 2-4 auto-retry (chorus); step 6 blocks indefinitely (human-owned); step 7 idempotent
```

### 4.2 `account-activation` workflow

```
trigger:  cron weekly  |  signal-threshold webhook (score jump)  |  manual (cli)
steps:
  1. pull_signals   → SignalSource.pull()/normalize() (sample default) → Signal[]; persist to MEMORY
  2. unify          → context engine: resolve accounts + EnrichmentProvider merge (provenance) → Account
  3. score          → ScoringProvider (HybridScorer) → rank; NOISE FILTER to top-N
  4. swarm          → for each top-N account: SDR-Researcher → Copywriter → GTM-Router → AccountDecision
  5. persist_dec    → WRITE Decision to COMPOUNDING MEMORY (DuckDB)
  6. draft          → Draft(outreach_email) → drafts/ (status:pending)
  7. HITL_APPROVAL  → ⛔ human approves in console (copilot)  |  auto-approve policy (autopilot, low-tier only) → Approval
  8. on_approve     → dispatch via gatecraft gc_proxy_call; WRITE Outcome → MEMORY (closes the loop)
retries:  steps 1-5 auto-retry; step 7 human-owned (copilot) or policy-gated (autopilot); step 8 idempotent
```

**Both workflows write to memory at least twice** (raw signal/asset in, decision/outcome out) — the compounding requirement is structural. Neither can reach an external send except through step 7's approval.

---

## 5. Drop-in integration guide

### 5.1 What the user plugs in (all optional except a Claude key for real runs)

| Slot | Seam | Offline default | To go live |
|---|---|---|---|
| **Signals** | `SignalSource` | `SampleSource` (`data/signals.sample.jsonl`) | register `PostHogSource` (key), `GitHubSignalSource` (PAT), point Jitsu/RudderStack/Segment at the `SegmentWebhookSource` endpoint, or `SqlWarehouseSource` (BYO warehouse) |
| **Enrichment** | `EnrichmentProvider` | `sample` fixtures | enable `llm-web` (Claude key + Crawl4AI) + keyless `wikidata/gleif/edgar/techdetect/email`; opt-in `opencorporates/pdl/hunter/logo/github-signals/osint-people` via gatecraft |
| **Scoring** | `ScoringProvider` | `RulesScorer` (zero dep) | `ClaudeScorer` (Claude key) for cold-start rationale; `OnnxScorer` once you have labeled conversions |
| **Guideline corpus** | `GuidelineCorpus` (LanceDB + rule tables) | `data/corpus/` sample north-star | drop in your approved-messaging docs (md/docx) → ingest; or run `authorGuidelines(brief)` to have Claude write v1 |
| **Outreach channel** | `OutreachChannel` (draft-first) | `drafts/` only (nothing sends) | register an email/Slack/Outreach channel; dispatch still requires an Approval |
| **Warehouse** | `memory` repository | DuckDB file | swap to Postgres (`pg`) for concurrency; attach Snowflake/BigQuery later — no rewrite |
| **Claude** | `agents` model map | — | `ANTHROPIC_API_KEY` (BYO). Offline `mstack seed`+fixtures still run without it for wiring smoke-tests; live agent output needs the key. |

**All keys are brokered by gatecraft** (`packages/credentials`) — providers never read `process.env`; the broker injects at call time and logs the call.

### 5.2 The 5-minute offline demo path (no credentials)

```bash
pnpm install
pnpm mstack seed          # loads sample signals + sample accounts + sample north-star corpus into DuckDB + LanceDB
pnpm mstack demo          # runs BOTH workflows end-to-end on sample data:
                          #   • content-review over data/corpus sample assets → Reviews + partner-email drafts
                          #   • account-activation over signals.sample.jsonl → Decisions + outreach drafts
pnpm --filter @mstack/portal dev    # Submit Content · Review Dashboard · INTERNAL — see RETURNED/APPROVED + findings
pnpm --filter @mstack/console dev   # signal stream · scoring · swarm · resolution studio · drafts awaiting approval
ls drafts/                # every candidate action sits here, status:pending — NOTHING was sent
```

With `ANTHROPIC_API_KEY` set, the same `mstack demo` uses live Claude for extraction/judgment/copy; without it, the demo runs the deterministic + rules + fixture path so the wiring is provable with zero cost. This is the offline-first requirement made concrete: **the whole loop runs, produces reviews + decisions + drafts, and touches no network and no credentials.**

---

## 6. Gap map — what's already free/OSS (adopt) vs what we build here

| Capability | Adopt (free/OSS) | Build here (why the OSS stops short) |
|---|---|---|
| Signal wire format | **Segment HTTP spec** (target the spec, not a product) | `SignalSource` seam + `SampleSource` — no OSS ships an offline, spec-shaped, swappable ingest atom |
| Event ingestion (real) | **Jitsu (MIT)**, **PostHog (MIT)**, LFX CDP/crowd.dev (Apache-2.0) as opt-in engines | thin `posthog`/`segment-webhook`/`github` adapters — CDPs are too heavy/source-available to bundle |
| Enrichment (firmographics) | **Wikidata/GLEIF/EDGAR (CC0/public-domain)**, **wappalyzergo (tech)**, **AfterShip email-verifier (MIT)** | `EnrichmentProvider` seam + router/merge with provenance — no OSS composes these into one enrichment record |
| Enrichment (the paid-vendor replacement) | **Crawl4AI (Apache-2.0) + Claude** = `llm-web` | the provider + schema-extraction glue — this IS the open replacement for Clay/Apollo/ZoomInfo "AI columns" (validated live in the transcript: Rajan beat a paid tool with a Claude skill) |
| Warehouse | **DuckDB (MIT)** via `@duckdb/node-api`; `pg` swap; **dbt-core (Apache-2.0)** | `memory` package (repo + hash-chained audit + compounding schema) — DuckDB is an engine, not a GTM data foundation |
| Lead/ICP scoring | **scikit-learn (BSD)** + `skl2onnx` + `onnxruntime-node`; optional FlockMTL/Ollama | `ScoringProvider` + **HybridScorer** — the survey found **no OSS MadKudu/Pocus**; composing rules+ML+LLM behind one seam *is* the contribution, and the LLM path adds an agent-actionable rationale a numeric score can't |
| Claim/brand review | **Claude + Zod**, **Transformers.js (bge-small)**, **LanceDB (Apache-2.0)**, **gitleaks (MIT)**, **promptfoo (MIT)** | the **reviewer** (deterministic rule layer + FacTool-shaped pipeline + rubric + guideline-authoring) — **nobody ships this OSS**; Anthropic built it internally |
| Guardrail framework | *(deliberately none)* — mine Guardrails-AI's validator taxonomy only | our deterministic rule layer — a Python guard framework adds a process boundary for logic Claude already does |
| Workflow runtime / retries / self-heal | **chorus** (ours) | workflow defs + draft-first dispatch — chorus is the engine; the marketing workflows are new |
| Draft-first + scoped access + audit | **workflow-bridge pattern** (ours, mirrored) | the dispatch queue + HITL gate + hash-chained Approval |
| Credential brokering | **gatecraft** (ours) `gc_proxy_call` | the `credentials` wrapper + provider registry |
| Agent orchestration | **Anthropic SDK + tool-use** (Claude-native) | `packages/agents` runtime — **NOT** LangChain/LangGraph (explicit constraint) |
| Signal→decision→action orchestration (the whole thing) | — (this is *the open gap* the landscape names) | the entire stack — incumbents (Tapistro/Unify/Demandbase) are closed SaaS |

**Read of the gap map:** ~80% of the *component* capability is already free/OSS and we adopt it wholesale. The build-here column is (a) the thin swappable seams that make it offline-first and drop-in, (b) the two agent products nobody ships openly (the claim-drift reviewer and the composed ICP scorer/decision engine), and (c) the connective runtime that turns components into a loop. That is precisely the open gap the landscape file identified: *"the developer-framework + orchestration layer for marketing agents is the open gap."*

---

## 7. Build task list for `/go` — ordered waves

Each task: `id · scope(files/package) · acceptance · model`. Waves are dependency-ordered; tasks within a wave parallelize (worktree-isolated). Model = the *build agent* (implementer) routing, distinct from the product-agent model map in §3.

### Wave 1 — foundation (types + seams + memory + sample data)
| id | scope | acceptance | model |
|---|---|---|---|
| W1-T1 | `packages/core`: all 10 domain Zod schemas + 5 seam interfaces (`SignalSource`, `EnrichmentProvider`, `ScoringProvider`, `GuidelineCorpus`, `OutreachChannel`) + model-id map | `tsc` clean; `zod` parse round-trips a fixture of every primitive; no field for reviewer-generated prose (enforced by a test) | sonnet |
| W1-T2 | `packages/memory`: DuckDB repo (`@duckdb/node-api`) for all primitives + append-only hash-chained audit table + migrations | write+read every primitive; audit `hash` chains verify; single-writer discipline documented | sonnet |
| W1-T3 | `data/`: `signals.sample.jsonl` (product_usage+crm+campaign+intent), `accounts.sample.json` (~30 companies+contacts), `corpus/` sample north-star (6-category rules + approved-messaging + tier-map) | `mstack seed` loads all into DuckDB + LanceDB with zero network | haiku |
| W1-T4 | `packages/credentials`: gatecraft `gc_proxy_call` wrapper + provider registry; env never read by providers | a stub provider resolves a key only via the broker; call logged | sonnet |

### Wave 2 — adapters (behind the seams)
| id | scope | acceptance | model |
|---|---|---|---|
| W2-T1 | `packages/adapters-signals`: `SampleSource`(default), `SegmentWebhookSource`, `PostHogSource`, `GitHubSignalSource`, `SqlWarehouseSource` | each yields valid `Signal[]`; Segment webhook validates spec with zod; sample runs offline | sonnet |
| W2-T2 | `packages/adapters-enrichment`: `sample`, `llm-web`(Crawl4AI+Claude), `wikidata`,`gleif`,`edgar`,`techdetect`,`email` + opt-in stubs + router/merge(provenance) | offline `sample` returns a full record; router prefers free→llm-web→paid; merge keeps per-field provenance | sonnet |
| W2-T3 | `packages/adapters-scoring`: `RulesScorer`, `ClaudeScorer`, `OnnxScorer`, `HybridScorer` (+ `train/` Python sidecar stub) | rules-only scores offline; hybrid attaches a rationale; ONNX loads a fixture model in-TS | sonnet |
| W2-T4 | `packages/reviewer` corpus layer: LanceDB + `@xenova/transformers` bge-small ingest/retrieve + deterministic rule layer (lexicon/regex/allowlist/denylist/tier-map) + gitleaks pass | ingest sample corpus; top-k retrieval returns passages; pre-scan flags planted violations deterministically | sonnet |

### Wave 3 — the agents
| id | scope | acceptance | model |
|---|---|---|---|
| W3-T1 | `packages/agents`: `runAgent` (Anthropic SDK + tool-use + Zod re-ask + context-pack builder + model router); tools `retrieve/sqlQuery/enrich` | a canned agent returns schema-valid output; one re-ask on injected parse failure; **opus** for reviewer-judge routing | opus |
| W3-T2 | `packages/reviewer` agent: extract→retrieve→judge→score pipeline + `authorGuidelines(brief)` helper; draft partner_email + review_export | on a sample asset with planted drift, returns correct `score`+6-category `findings[]`; produces 2 pending drafts; emits **no** marketing prose (test) | opus |
| W3-T3 | `packages/account-intel`: context engine + swarm (SDR-Researcher/Copywriter/GTM-Router) + `AccountDecision` | on sample signals, produces a Decision with `relevantSignals` citing real `signalId`s, a committee, an outreach draft | sonnet |

### Wave 4 — workflows + draft-first gate
| id | scope | acceptance | model |
|---|---|---|---|
| W4-T1 | `chorus/content-review.ts` + `packages/runtime` dispatch queue + HITL approval step | webhook fires the full pipeline; draft cannot dispatch without an `approved` Approval; Review+Outcome hit memory | sonnet |
| W4-T2 | `chorus/account-activation.ts` (cron+webhook+manual) + autopilot auto-approve policy (low-tier only, logged) | weekly run scores→swarms→drafts→(approve)→Outcome; autopilot never fires for STRONG_FIT/VIP (test) | sonnet |
| W4-T3 | `packages/runtime` gatecraft-brokered `OutreachChannel` + self-heal wiring | dispatch on approve goes through `gc_proxy_call`; a simulated API drift triggers chorus repair path | sonnet |

### Wave 5 — apps + demo + evals
| id | scope | acceptance | model |
|---|---|---|---|
| W5-T1 | `apps/portal`: Submit Content · Review Dashboard (RETURNED/APPROVED) · INTERNAL ledger | submit a sample asset → see findings + drafted email; dashboard lists reviews with status color | sonnet |
| W5-T2 | `apps/console`: signal stream · scoring · swarm log · resolution studio · Copilot↔Autopilot · approval panel | run activation → see scored accounts, swarm reasoning, committee, a draft awaiting approval | sonnet |
| W5-T3 | `apps/cli` `mstack`: `seed·demo·review·score·approve` | `mstack demo` runs both workflows offline, exits 0, prints the drafts/ path | haiku |
| W5-T4 | `promptfoo` eval suite (reviewer precision/recall per category + rubric agreement; scorer sanity) over a labeled sample set | eval runs in CI; reviewer hits a set threshold on the labeled assets | sonnet |

**Wave 5 sidecar (optional, non-blocking):** Python `packages/adapters-scoring/train/` (scikit-learn LogisticRegression→GradientBoosting → `skl2onnx`) — the *only* Python in the repo, and it runs offline at train time, never at inference.

---

## 8. Guardrails from the transcript (the design must enforce these)

Each is tied to where the design makes it mechanical rather than aspirational — because the speakers learned each the hard way.

1. **Reviewer never generates content.** *Enforcement:* `ReviewResult` has **no field** for generated prose; `Finding.recommendedChange` is a targeted instruction; the system prompt forbids drafting replacements; the only artifacts it drafts are the partner *email* and the annotated *review export* (process artifacts, not marketing copy). W3-T2 acceptance includes a "emits no marketing prose" test. *(Saqib: "not a content generator ... a reviewer and a tracker.")*

2. **A human approves every send.** *Enforcement:* no adapter has a direct-send method; `Draft → dispatched` requires an `approved` `Approval`; `runtime/dispatch.ts` is the sole send path and refuses otherwise. Autopilot is an explicit, logged auto-approve **policy** scoped to low-tier accounts — never STRONG_FIT/VIP (W4-T2 test). *(Guan: "humans still stay in the loop before any message goes out.")*

3. **Keep every record — compounding memory is the point.** *Enforcement:* every workflow writes to `memory` at least twice (raw in, decision/outcome out); `Signal/Account/Decision/Review/Draft/Approval/Outcome` all persist; agents read history; nothing is ephemeral. *(Guan's #1 lesson: "my AI is lying to me because it didn't have the context." )*

4. **Start small, then extend.** *Enforcement:* the monorepo lets a team ship just `reviewer` **or** just `account-intel`; `agents` is the shared mechanism so the "hub" emerges by adding workflows, not by rewriting. *(Saqib: "starts from one app or workflow, but slowly it becomes a hub for all the apps ... don't let perfection be the enemy of good.")*

5. **Don't require Snowflake (or any one vendor).** *Enforcement:* DuckDB embedded is the default warehouse; Snowflake/Postgres/BigQuery are optional swaps behind the `memory` repository interface; every external dependency sits behind a seam with a `sample`/offline default. The whole loop runs on a laptop with no account. *(Guan demos Snowflake but the meta-lesson is the pattern; the landscape/tool files make "don't require it" the headline.)*

6. **Ground the agents; resolve conflicts by trust, don't average.** *Enforcement:* the context engine normalizes signals + merges enrichment with a trust order (`registry > llm-web > paid`) and per-field provenance; the swarm is bound to persisted `signalId`s ("never invent a signal"); the reviewer cites a `supportingPassageId` or marks unsupported. *(Guan's Q&A on conflicting data sources → "feature engineering / structured foundation"; harness policy: "conflict is the finding.")*

7. **ROI is capacity, not headcount cut — so optimize for throughput + auditability.** *Enforcement:* the ledger/dashboards (INTERNAL tab, console runs, Outcome rows) exist so the value shows up as *more reviews/decisions handled with the same team* and a defensible record — the framing both speakers land on. *(Saqib: "home by 5:30 is a great ROI"; both: "do more," not "do the same with fewer.")*

---

## Appendix — what this spec deliberately does NOT establish (negative space)

- **No real connector credentials or live-vendor behavior are specified** beyond the seam contracts — the tool files pin licenses/limits; exact API pagination/auth per provider is an implementation detail for Wave 2 (kept out so the seams stay stable).
- **The NLI/PII phase-2 backstops (MiniCheck/DeBERTa, Presidio) are scoped but not required for v1** — they are the audit-grade, model-independent layer to add when the reviewer's judgments must be defensible without trusting Claude to grade itself. Deferring them is a conscious v1 cut, not an oversight.
- **UI/UX of the two apps is specified functionally (tabs/panels/columns), not visually** — layout, theming, and component library are left to the app-build waves.
- **Autopilot's business policy** (which tiers/accounts qualify, rate limits, kill-switch) is scoped to "low-tier, logged, never VIP" — the exact policy table is a per-deployer decision the `runtime` should expose as config, not hardcode.
- **Concurrency beyond single-writer DuckDB** is handled by the documented Postgres swap, but the multi-writer migration itself is future work (flagged in §2), not built in v1.
- **Model-id drift:** the product-agent model map uses the ids the task specified (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`); verify them live against the models endpoint before shipping, per harness policy on cached model catalogs.
```
