# D — Warehouse + Lead/ICP Scoring Layer (FREE & OPEN-SOURCE)

**Researcher:** researcher-delta
**Date:** 2026-07-20
**Task:** Evaluate FREE & OPEN-SOURCE tools for the DATA WAREHOUSE + LEAD/ICP SCORING layer of an open, drop-in "Marketing Agents in Production" stack (Claude-native agents on a TS workflow runtime). Open alternative to Guan's demo (Snowflake data layer + paid "ML scoring engine" producing ICP fit scores; agents reasoning over it). Must run locally/offline for v1.

## Progress tracker
- [x] DuckDB (embedded OLAP)
- [x] dbt-core (transforms)
- [x] @duckdb/node-api (TS client)
- [x] Snowflake Cortex OPEN alternatives (LLM-in-SQL)
- [x] SQLite / Postgres (comparison)
- [x] Semantic layers (Cube, dbt MetricFlow, Boring Semantic Layer)
- [x] Feature stores (Feast)
- [x] DuckDB LLM extensions (flockmtl, open_prompt)
- [x] pgvector / Postgres AI
- [x] MadKudu / Pocus OPEN alternatives (lead scoring landscape)
- [x] scikit-learn scoring (logistic regression / gradient boosting)
- [x] LLM-as-scorer (Claude scoring accounts)
- [x] Final recommendation

---

## TL;DR — RECOMMENDATION FIRST

**Default v1 = DuckDB (embedded, MIT) as the warehouse + a `HybridScorer` (rules + optional scikit-learn/ONNX + Claude-as-scorer) behind ONE `ScoringProvider` interface.** Same ICP-fit output as the Snowflake + paid-ML demo, at $0, fully offline, with an agent-readable rationale and a no-rewrite path to the cloud. Concrete packages: `@duckdb/node-api`, `pg` (optional Postgres swap), `dbt-core`+`dbt-duckdb`, `scikit-learn`+`skl2onnx`+`onnxruntime-node`, the Claude TS SDK; optional `flockmtl`/`open_prompt` + Ollama for in-SQL batch LLM scoring. Full reasoning at the bottom.

---

## RAW FINDINGS (per source)

### DuckDB — embedded analytical (OLAP) database
- **What:** In-process SQL OLAP DBMS. Columnar-vectorized, no server/daemon/cluster. Queries Parquet/CSV/Iceberg directly from a laptop. "SQLite for analytics."
- **License:** MIT, held by the DuckDB Foundation "in perpetuity."
- **Local-first:** Yes — runs completely embedded in the host process; zero config.
- **Status (2026):** v1.5.2 production-ready; ecosystem growing fast; named go-to for local high-performance SQL.
- Sources: https://duckdb.org/why_duckdb , https://en.wikipedia.org/wiki/DuckDB , https://kestra.io/blogs/embedded-databases , https://motherduck.com/learn/top-snowflake-alternatives-2026/

### dbt-core — SQL transformation framework (the "T" in ELT)
- **What:** Analysts write `select` statements; dbt turns them into tables/views in the warehouse. Does transformation only (not extract/load). Version control, tests, docs, lineage.
- **License:** Apache 2.0. Fivetran+dbt Labs committed to maintaining dbt Core under Apache 2 "indefinitely."
- **2026:** dbt Core v2.0 first alpha released 2026-06-01; the (Rust) dbt Fusion engine now powers both Core (OSS, Apache 2.0) and Fusion (proprietary) distributions.
- **Local-first:** Yes — CLI tool; works against DuckDB via `dbt-duckdb` adapter, fully offline.
- Sources: https://github.com/dbt-labs/dbt-core , https://www.getdbt.com/licenses-faq , https://docs.getdbt.com/blog/dbt-core-v2-is-here , https://pypi.org/project/dbt-core/

### @duckdb/node-api — official DuckDB Node.js/TS client ("Neo")
- **What:** High-level DuckDB client for Node apps. Native Promises (no `duckdb-async` wrapper needed). Built ground-up in TypeScript. Depends on `@duckdb/node-bindings` (C API).
- **Version:** 1.5.4-r.1 (published ~9 days before search). Marked "alpha" but most of the C API surface is exposed and tested.
- **Install:** `npm i @duckdb/node-api`
- **Relevance:** The direct in-TS-runtime path — the marketing-agents TS runtime can embed DuckDB with no Python sidecar for the warehouse layer.
- Sources: https://www.npmjs.com/package/@duckdb/node-api , https://duckdb.org/docs/current/clients/node_neo/overview , https://github.com/duckdb/duckdb-node-neo

### Snowflake Cortex — OPEN alternatives (LLM-in-SQL)
- Snowflake Cortex = LLM functions callable in SQL (COMPLETE, classify, sentiment, embed) over warehouse data.
- **Open/local angles:**
  - **DuckDB** as the free local analytical engine; official **DuckDB MCP server** connects an LLM/agent to DuckDB for natural-language querying (serves schema context so agents build valid SQL).
  - **MotherDuck** (DuckDB cloud hybrid) has a native **MCP** for serving schema context to LLMs; sub-second spin-up. (Cloud, not fully local, but DuckDB-compatible.)
  - **Dremio** exposes built-in AI SQL functions (AI_CLASSIFY, AI_COMPLETE, AI_GENERATE). (Not embedded/local-first.)
  - The true local equivalent of "LLM function inside SQL" is a **DuckDB extension** — **FlockMTL / open_prompt** (below).
- Sources: https://motherduck.com/learn/top-snowflake-alternatives-2026/ , https://www.infoworld.com/article/4181843/10-mcp-servers-to-connect-llms-with-databases.html , https://www.dremio.com/blog/snowflake-competitors/

### Cube (Cube Core) — open-source semantic layer / headless BI
- **What:** Semantic layer between DB and apps. Define metrics once; serve consistent data to BI, apps, AI agents. Built-in caching + pre-aggregations, access control. Exposes REST, GraphQL, SQL, MDX, DAX — and an **MCP interface for AI agents**.
- **License:** Cube Core = Apache 2.0.
- **Local-first:** Yes — self-hostable Node service; can sit on top of DuckDB/Postgres.
- **vs dbt MetricFlow:** dbt Labs open-sourced **MetricFlow under Apache 2.0 (Oct 2025)**. MetricFlow defines metrics inside the dbt project, tightly integrated, but (2026) leans on the warehouse to execute and ships **no pre-aggregation cache**. Cube adds caching/rollups + agent APIs. Choose dbt SL if dbt is the center; choose Cube for embedded/agent-facing serving.
- Sources: https://github.com/cube-js/cube , https://cube.dev/articles/dbt-semantic-layer-alternatives-2026 , https://getbruin.com/blog/semantic-layer-tools/

### Boring Semantic Layer (BSL) — lightweight, MCP-native semantic layer
- **What:** Minimal Python semantic layer on **Ibis** (inspired by Malloy). Define metrics once, query any Ibis backend (**DuckDB**, BigQuery, Snowflake…). Ships with **MCP integration** (via xorq) — connect Claude Code/agents to structured data out of the box.
- **License/status:** Open source (`boringdata/boring-semantic-layer`, joint xorq-labs + boringdata); v0.3.x; released 2026-06-30.
- **vs Cube:** far lighter (a library, not a service). Good fit when you want agent-facing metrics over DuckDB without standing up Cube's caching service.
- Sources: https://pypi.org/project/boring-semantic-layer/ , https://github.com/boringdata/boring-semantic-layer , https://motherduck.com/blog/semantic-layer-duckdb-tutorial/

### Feast — open-source feature store
- **What:** Feature store for ML. Two components: **offline store** (historical features for training / point-in-time joins) + **online store** (low-latency serving). Modular/extensible.
- **License:** Apache 2.0.
- **Local-first:** Partially — file-based offline store + local providers exist; online stores include **PostgreSQL**, Redis, MySQL, file options. Offline store implementations: Dask, BigQuery, Snowflake, Redshift (+ file). Runs locally but is heavier infra.
- **Relevance:** The "feature layer" if scoring grows to real ML with point-in-time correctness. For v1 it is likely OVERKILL.
- Sources: https://github.com/feast-dev/feast , https://docs.feast.dev/ , https://feast.dev/

### FlockMTL — DuckDB LLM/RAG extension (the true local "Cortex-in-SQL")
- **What:** DuckDB community extension that puts LLMs + RAG **inside SQL**. `MODEL` and `PROMPT` as first-class SQL objects; functions `llm_complete`, `llm_filter`, `llm_rerank` (scalar + aggregate). RAG helpers too.
- **Providers:** Local **Ollama** (open-source models), Azure, OpenAI or any OpenAI-compatible (e.g. Groq).
- **License/origin:** Research from DAIS Lab @ Polytechnique Montréal (VLDB 2025 demo, "Beyond Quacking"). MIT (repo `dais-polymtl/flock`). Marked experimental.
- **This is the open, local equivalent of Snowflake Cortex's SQL LLM functions.** You can literally `SELECT llm_complete(...)` to score an account row-by-row against a local model.
- **open_prompt** — simpler alternative community extension: query any OpenAI-compatible completion endpoint (incl. `http://localhost:11434/v1/...` Ollama) from SQL. Repo `Query-farm/openprompt`.
- Sources: https://duckdb.org/community_extensions/extensions/flockmtl , https://github.com/dais-polymtl/flock , https://duckdb.org/library/beyond-quacking-flockmtl/ , https://github.com/Query-farm/openprompt

### pgvector — Postgres vector similarity (adjacent, not core to scoring)
- **What:** Postgres extension for storing embeddings + exact/ANN similarity search (HNSW, IVFFlat). For semantic retrieval/recommendations, not ICP scoring per se.
- **License:** Open source (permissive; repo `pgvector/pgvector`). Local-first: yes, ships in Postgres/Docker/Homebrew.
- **Relevance:** Only if the stack needs "find lookalike accounts / retrieve similar past deals" as a scoring *feature*. Not required for v1 scoring; note as later-EXTEND.
- Sources: https://github.com/pgvector/pgvector , https://pgxn.org/dist/vector/

### SQLite vs DuckDB vs Postgres — pick the warehouse
- **SQLite:** row-based OLTP; great for edge/embedded/mobile transactional storage; **public-domain**. Slow on analytics (45–60s where DuckDB is <3s).
- **DuckDB:** columnar-vectorized OLAP; embedded, serverless, zero-admin; queries CSV/Parquet directly, no import. **Single writer at a time** — not for high-concurrency multi-user OLTP. ~13× faster than an indexed Postgres 16.4 aggregation in one benchmark.
- **Postgres:** server-based; production concurrent OLTP + decent OLAP with indexes; **PostgreSQL license (permissive)**. The right call when many agents/services write concurrently or you need a durable shared store.
- **2026 consensus:** complementary. DuckDB for analytics, SQLite for edge, Postgres for production/concurrency. Common shape: SQLite/Postgres as system-of-record, **DuckDB as the analytics/scoring engine** over Parquet + pulled rows.
- Sources: https://motherduck.com/learn/duckdb-vs-postgres-embedded-analytics/ , https://kestra.io/blogs/embedded-databases , https://builder.ai2sql.io/blog/duckdb-vs-sqlite-vs-postgresql , https://duckdblab.org/en/post/duckdb-vs-sqlite-benchmark/

### Lead-scoring vendor landscape (MadKudu / Pocus) — what we're replacing
- **MadKudu:** predictive lead scoring for B2B SaaS; ML over customer data to score/target high-value leads.
- **Pocus:** PLS platform surfacing product-usage data with no-code dashboards + playbooks.
- **Key finding:** the survey of alternatives (Breadcrumbs, UserMotion, etc.) turned up **NO open-source drop-in** for MadKudu/Pocus — all alternatives are commercial SaaS. Some have free tiers (Breadcrumbs free plan; UserMotion free ICP+intent scoring ≤1,000 accounts) but none are OSS/local.
- **Implication:** the OPEN path is not "adopt an OSS MadKudu" — it's **compose our own scorer** (rules + scikit-learn + LLM) behind an interface. That is the gap this stack fills.
- Sources: https://usermotion.com/blog/10-predictive-lead-scoring-software , https://outfunnel.com/madkudu-vs-pocus/ , https://breadcrumbs.io/madkudu-alternatives/

### scikit-learn — the ML scorer (logistic regression / gradient boosting)
- **What:** Standard ML lib. For lead/propensity scoring: **LogisticRegression** (simple, interpretable, 0–1 probability over firmographic+engagement features, good baseline) and **GradientBoostingClassifier** (non-linear feature interactions; XGBoost/LightGBM for scale).
- **License:** BSD-3-Clause. **Local-first:** Yes — pure Python, trains offline.
- **Recommended pattern:** train logistic regression FIRST as the interpretable baseline on the same validation split; only escalate to tree/boosting when the dataset is rich enough (multi-step forms, behavioral events, enriched firmographics). `predict_proba` → 0–100 fit score.
- Sources: https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.GradientBoostingClassifier.html , https://diggrowth.com/blogs/analytics/machine-learning-for-lead-scoring/ , https://www.reform.app/blog/lead-scoring-hyperparameter-tuning-models

### scikit-learn → ONNX → TS runtime (no Python at inference)
- **skl2onnx** (`sklearn-onnx`) converts a trained scikit-learn model/pipeline to an ONNX file (`to_onnx()` → `SerializeToString()`).
- **onnxruntime-node** runs that ONNX model **inside Node/TS** — training is a one-off Python job, but *inference* needs no Python sidecar. Model artifact is small (fits under serverless limits).
- **Consequence for the interface:** the ML scorer can be a pure-TS provider at runtime (load `.onnx`, `predict_proba`), keeping the whole hot path in the TS workflow runtime.
- Sources: https://onnx.ai/sklearn-onnx/ , https://github.com/onnx/sklearn-onnx , https://onnxruntime.ai/docs/

### LLM-as-scorer — Claude scoring an account from context
- **Pattern:** feed firmographics + engagement signals into Claude; it returns a rubric-scored verdict. Documented Claude account-targeting flow buckets accounts as **STRONG FIT / FIT / PARTIAL FIT / DISQUALIFIED** (core ICP criteria + signal).
- **Method:** LLM-as-judge with **chain-of-thought before the score** (G-Eval style: reason through explicit eval steps, then emit a structured score). Require the judge to reason first, output structured JSON.
- **Quality:** strong LLM judges reach **80–90% agreement with human evaluators** — comparable to human inter-annotator agreement. Use the most capable model you can afford; Claude Sonnet 4.5 cited top-tier for subjective rubrics.
- **Fit for us:** the **cold-start scorer** (works with zero training data, gives a natural-language *rationale* an agent can act on) and complements the ML model (which needs labels). Native to a Claude-agent stack.
- Sources: https://www.lusha.com/blog/best-claude-prompts-account-targeting-saas-companies/ , https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge , https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method

---

## SYNTHESIS — decision matrix

| Tool | Layer | License | Local-first | TS-runtime plug | Verdict (v1) |
|------|-------|---------|-------------|-----------------|--------------|
| **DuckDB** | Warehouse (OLAP) | MIT | yes, embedded | `@duckdb/node-api` (native TS) | **ADOPT — default** |
| **Postgres** | Warehouse (OLTP+prod) | PostgreSQL | yes (server) | `pg` (node-postgres) | **ADOPT — optional swap** |
| SQLite | System-of-record (OLTP) | Public domain | yes, embedded | `better-sqlite3` | SKIP for analytics (wrong workload) |
| **dbt-core** (+`dbt-duckdb`) | Transforms (T) | Apache 2.0 | yes (CLI) | run via Bash/CI step | **ADOPT** (or defer to plain SQL for min-v1) |
| dbt MetricFlow | Semantic layer | Apache 2.0 | yes | via dbt | EXTEND-later (if dbt-centric metrics) |
| Cube Core | Semantic layer / headless BI | Apache 2.0 | yes (Node svc) | REST/GraphQL/SQL/**MCP** | EXTEND-later (agent metrics + caching) |
| Boring Semantic Layer | Semantic layer (lightweight) | OSS (Ibis-based) | yes (Python lib) | **MCP** / Python sidecar | EXTEND (nice agent-facing option) |
| Feast | Feature store | Apache 2.0 | partial | Python sidecar | SKIP v1 (overkill; revisit at ML scale) |
| **FlockMTL** / open_prompt | LLM-in-SQL (Cortex parity) | MIT / OSS | yes (Ollama) | DuckDB extension (SQL) | EXTEND (batch LLM scoring over local models) |
| pgvector | Vector search (adjacent) | OSS permissive | yes | via `pg` | EXTEND-later (lookalike retrieval only) |
| **scikit-learn** (+`skl2onnx`) | ML scorer | BSD-3 | yes (offline train) | ONNX → `onnxruntime-node` (in-TS inference) | **ADOPT — optional ML provider** |
| **Claude LLM-as-scorer** | Scorer (cold-start + rationale) | n/a (our stack) | API (or Ollama local) | native TS SDK call | **ADOPT — default scorer** |
| MadKudu / Pocus | (vendor being replaced) | proprietary | no | — | SKIP (no OSS drop-in exists — we compose our own) |

---

## THE "SCORING PROVIDER" INTERFACE (one seam, three implementations)

The key architectural move: **one interface, swappable providers**, so a team can start with rules-only (zero deps), add the LLM scorer (cold-start, no labels), and later train the ML model — without touching agent code.

```ts
export type FitTier = 'STRONG_FIT' | 'FIT' | 'PARTIAL_FIT' | 'DISQUALIFIED';

export interface AccountFeatures {
  domain: string;
  firmographic: Record<string, number | string | boolean>; // employees, industry, region, tech
  engagement:   Record<string, number>;                    // sessions, docs_read, seats_active, days_since_signup
  context?: string;                                        // free-form text for the LLM scorer
}

export interface ScoreResult {
  score: number;          // 0-100 ICP fit (the "Vercel 78/100")
  tier: FitTier;
  rationale?: string;     // present for the LLM provider - agent-actionable
  provider: string;       // 'rules' | 'ml-onnx' | 'llm-claude' | 'hybrid'
  confidence?: number;
}

export interface ScoringProvider {
  readonly name: string;
  score(a: AccountFeatures): Promise<ScoreResult>;
}
```

**Three providers behind it:**
1. `RulesScorer` — pure TS. Weighted firmographic + engagement rules → 0–100. Always-on baseline, zero deps, fully offline, deterministic/explainable.
2. `OnnxScorer` — loads a `model.onnx` (scikit-learn LogisticRegression → GradientBoosting, trained offline in Python, exported by `skl2onnx`), runs `predict_proba` in-process via `onnxruntime-node`. No Python at inference. Optional — activates once labels exist.
3. `ClaudeScorer` — sends features+context to Claude with a rubric + chain-of-thought + structured JSON out (`{score, tier, rationale}`). Cold-start (no training data), native to a Claude-agent stack, and returns a *reason* the agent can reason over.

**`HybridScorer` (the default)** composes them: rules provide a fast floor + hard disqualifiers; the ML model supplies a calibrated probability when available; the LLM supplies the rationale and breaks ties / handles sparse-signal accounts. Blend = `max(rules_floor, weighted(ml, llm))` with the LLM rationale always attached. A batch path can push scoring **into DuckDB SQL** via FlockMTL/`open_prompt` over local Ollama when scoring thousands of accounts at once.

---

## RECOMMENDED DEFAULT FOR v1

**Warehouse:** **DuckDB embedded in the TS runtime via `@duckdb/node-api`** (MIT, zero-config, ~13× faster than indexed Postgres for the analytical aggregations scoring needs, reads Parquet/CSV/Postgres directly). Keep a **Postgres (`pg`) provider behind the same repository interface** for teams that need concurrent multi-writer/production durability — DuckDB's single-writer limit is the only reason to reach for it. **SQLite** only as an optional system-of-record, never the analytics engine.

**Transforms:** **dbt-core + `dbt-duckdb`** (Apache 2.0) for versioned, tested SQL models — or plain SQL migrations for an absolute-minimal v1, upgrading to dbt when models multiply.

**Scorer:** a **`HybridScorer`** behind the single `ScoringProvider` interface:
- `RulesScorer` (pure TS) — the always-on, zero-dep baseline.
- `ClaudeScorer` (Claude via the TS SDK, or a local Ollama model) — the **default cold-start scorer**; emits `STRONG_FIT/FIT/PARTIAL_FIT/DISQUALIFIED` + 0–100 + **rationale**.
- `OnnxScorer` (scikit-learn `LogisticRegression`→`GradientBoosting`, `skl2onnx` → `onnxruntime-node`) — opt-in once labeled conversions exist; runs in-TS, no Python at inference.

**Concrete packages:** `@duckdb/node-api`, `pg`, `dbt-core`+`dbt-duckdb`, `scikit-learn`+`skl2onnx`+`onnxruntime-node`, the Claude TS SDK; optional `flockmtl`/`open_prompt` (DuckDB) + Ollama for in-SQL batch LLM scoring; optional Cube Core or Boring Semantic Layer if agent-facing metrics are needed later.

### Why this beats requiring Snowflake
1. **$0 and offline.** No Snowflake account, no paid ML-scoring vendor, no network. The whole warehouse+scoring path runs on a laptop — this removes the single biggest adoption barrier of Guan's demo and is what makes the stack genuinely "drop-in."
2. **Faster where it matters.** DuckDB runs the scoring aggregations in-process (no warehouse round-trip) and benchmarks ~13× over an indexed Postgres query — the "Vercel 78/100" recompute is sub-second locally.
3. **No lock-in, clean upgrade path.** dbt models and Ibis/BSL/Cube semantic definitions retarget Snowflake/BigQuery later with **no rewrite**; DuckDB can attach Postgres and read Parquet directly. Local-by-default, cloud-when-you-must.
4. **We own the scorer (and it's better for agents).** There is **no OSS MadKudu/Pocus** to adopt — so composing rules+ML+LLM behind one interface *is* the open contribution. Unlike a paid black-box numeric score, the LLM provider returns an **actionable rationale** an agent can reason over, and works at **cold-start with zero training data** (where MadKudu needs history).
5. **Cortex parity, locally.** FlockMTL/`open_prompt` give the same "LLM function inside SQL" over local Ollama — matching Snowflake Cortex's headline capability with MIT-licensed, offline tooling.

**One-line pitch:** *DuckDB (embedded, MIT) as the warehouse + a `HybridScorer` (rules + optional scikit-learn/ONNX + Claude-as-scorer) behind one `ScoringProvider` interface — same ICP-fit output as the Snowflake + paid-ML demo, at $0, offline, with an agent-readable rationale and a no-rewrite path to the cloud.*
