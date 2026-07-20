# D — Warehouse + Lead/ICP Scoring Layer (FREE & OPEN-SOURCE)

**Researcher:** researcher-delta
**Date:** 2026-07-20
**Task:** Evaluate FREE & OPEN-SOURCE tools for the DATA WAREHOUSE + LEAD/ICP SCORING layer of an open, drop-in "Marketing Agents in Production" stack (Claude-native agents on a TS workflow runtime). Open alternative to Guan's demo (Snowflake data layer + paid "ML scoring engine" producing ICP fit scores; agents reasoning over it). Must run locally/offline for v1.

## Progress tracker
- [x] DuckDB (embedded OLAP)
- [x] dbt-core (transforms)
- [x] @duckdb/node-api (TS client)
- [x] Snowflake Cortex OPEN alternatives (LLM-in-SQL)
- [ ] SQLite / Postgres (comparison)
- [ ] Semantic layers (Cube, dbt MetricFlow, Boring Semantic Layer)
- [ ] Feature stores (Feast)
- [ ] DuckDB LLM extensions (flockmtl, open-prompt)
- [ ] pgvector / Postgres AI
- [ ] MadKudu / Pocus OPEN alternatives (lead scoring landscape)
- [ ] scikit-learn scoring (logistic regression / gradient boosting)
- [ ] LLM-as-scorer (Claude scoring accounts)
- [ ] Final recommendation

---

## RAW FINDINGS (appended per source; synthesized at bottom)

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
- **Relevance:** This is the direct in-TS-runtime path — the marketing-agents TS runtime can embed DuckDB with no Python sidecar for the warehouse layer.
- Sources: https://www.npmjs.com/package/@duckdb/node-api , https://duckdb.org/docs/current/clients/node_neo/overview , https://github.com/duckdb/duckdb-node-neo

### Snowflake Cortex — OPEN alternatives (LLM-in-SQL)
- Snowflake Cortex = LLM functions callable in SQL (COMPLETE, classify, sentiment, embed) over warehouse data.
- **Open/local angles found so far:**
  - **DuckDB** as the free local analytical engine; official **DuckDB MCP server** connects an LLM/agent to DuckDB for natural-language querying (serves schema context so agents build valid SQL).
  - **MotherDuck** (DuckDB cloud hybrid) has a native **MCP** for serving schema context to LLMs; sub-second spin-up. (Cloud, not fully local, but DuckDB-compatible.)
  - **Dremio** exposes built-in AI SQL functions (AI_CLASSIFY, AI_COMPLETE, AI_GENERATE). (Not embedded/local-first.)
  - NOTE: the true local equivalent of "LLM function inside SQL" is a **DuckDB extension** (flockmtl / open_prompt) — pending deeper search below.
- Sources: https://motherduck.com/learn/top-snowflake-alternatives-2026/ , https://www.infoworld.com/article/4181843/10-mcp-servers-to-connect-llms-with-databases.html , https://www.dremio.com/blog/snowflake-competitors/

### Cube (Cube Core) — open-source semantic layer / headless BI
- **What:** Semantic layer between DB and apps. Define metrics once; serve consistent data to BI, apps, AI agents. Built-in caching + pre-aggregations, access control. Exposes REST, GraphQL, SQL, MDX, DAX — and an **MCP interface for AI agents**.
- **License:** Cube Core = Apache 2.0.
- **Local-first:** Yes — self-hostable Node service; can sit on top of DuckDB/Postgres.
- **vs dbt MetricFlow:** dbt Labs open-sourced **MetricFlow under Apache 2.0 (Oct 2025)**. MetricFlow defines metrics inside the dbt project, tightly integrated, but (2026) leans on the warehouse to execute and ships **no pre-aggregation cache**. Cube adds caching/rollups + agent APIs. Choose dbt SL if dbt is the center; choose Cube for embedded/agent-facing serving.
- Sources: https://github.com/cube-js/cube , https://cube.dev/articles/dbt-semantic-layer-alternatives-2026 , https://getbruin.com/blog/semantic-layer-tools/

### Feast — open-source feature store
- **What:** Feature store for ML. Two components: **offline store** (historical features for training / point-in-time joins) + **online store** (low-latency serving). Modular/extensible.
- **License:** Apache 2.0.
- **Local-first:** Partially — file-based offline store + local providers exist; online stores include **PostgreSQL**, Redis, MySQL, SQLite-ish file options. Offline store implementations: Dask, BigQuery, Snowflake, Redshift (+ file). Runs locally but is heavier infra.
- **Relevance:** Would be the "feature layer" if scoring grows to real ML with point-in-time correctness. For v1 it is likely OVERKILL.
- Sources: https://github.com/feast-dev/feast , https://docs.feast.dev/ , https://feast.dev/

### FlockMTL — DuckDB LLM/RAG extension (the true local "Cortex-in-SQL")
- **What:** DuckDB community extension that puts LLMs + RAG **inside SQL**. `MODEL` and `PROMPT` as first-class SQL objects; functions `llm_complete`, `llm_filter`, `llm_rerank` (scalar + aggregate). RAG helpers too.
- **Providers:** Local **Ollama** (open-source models), Azure, OpenAI or any OpenAI-compatible (e.g. Groq).
- **License/origin:** Research from DAIS Lab @ Polytechnique Montréal (VLDB 2025 demo, "Beyond Quacking"). MIT (repo `dais-polymtl/flock`). Marked experimental.
- **This is the open, local equivalent of Snowflake Cortex's SQL LLM functions.** You can literally `SELECT llm_complete(...)` to score an account row-by-row against a local model.
- **open_prompt** — simpler alternative community extension: query any OpenAI-compatible completion endpoint (incl. `http://localhost:11434/v1/...` Ollama) from SQL. Repo `Query-farm/openprompt`.
- Sources: https://duckdb.org/community_extensions/extensions/flockmtl , https://github.com/dais-polymtl/flock , https://duckdb.org/library/beyond-quacking-flockmtl/ , https://github.com/Query-farm/openprompt

### Lead-scoring vendor landscape (MadKudu / Pocus) — what we're replacing
- **MadKudu:** predictive lead scoring for B2B SaaS; ML over customer data to score/target high-value leads.
- **Pocus:** PLS platform surfacing product-usage data with no-code dashboards + playbooks.
- **Key finding:** the survey of alternatives (Breadcrumbs, UserMotion, etc.) turned up **NO open-source drop-in** for MadKudu/Pocus — all alternatives are commercial SaaS. Some have free tiers (Breadcrumbs free plan; UserMotion free ICP+intent scoring ≤1,000 accounts) but none are OSS/local.
- **Implication:** the OPEN path is not "adopt an OSS MadKudu" — it's **compose our own scorer** (rules + scikit-learn + LLM) behind an interface. That's the gap this stack fills.
- Sources: https://usermotion.com/blog/10-predictive-lead-scoring-software , https://outfunnel.com/madkudu-vs-pocus/ , https://breadcrumbs.io/madkudu-alternatives/

### scikit-learn — the ML scorer (logistic regression / gradient boosting)
- **What:** Standard ML lib. For lead/propensity scoring: **LogisticRegression** (simple, interpretable, outputs 0–1 probability, good baseline over firmographic+engagement features) and **GradientBoostingClassifier** (captures non-linear feature interactions; XGBoost/LightGBM for scale).
- **License:** BSD-3-Clause. **Local-first:** Yes — pure Python, trains offline.
- **Recommended pattern:** train logistic regression FIRST as the interpretable baseline on the same validation split; only escalate to tree/boosting models when the dataset is rich enough (multi-step forms, behavioral events, enriched firmographics). `predict_proba` → 0–100 fit score.
- **TS-runtime plug:** Python sidecar (train offline → export). Serve via (a) tiny FastAPI `/score`, or (b) export to **ONNX** and run in-process in TS via `onnxruntime-node` (no Python at inference).
- Sources: https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.GradientBoostingClassifier.html , https://diggrowth.com/blogs/analytics/machine-learning-for-lead-scoring/ , https://www.reform.app/blog/lead-scoring-hyperparameter-tuning-models

### SQLite vs DuckDB vs Postgres — pick the warehouse
- **SQLite:** row-based OLTP; great for edge/embedded/mobile transactional storage; **public-domain**. Slow on analytics (45–60s where DuckDB is <3s).
- **DuckDB:** columnar-vectorized OLAP; embedded, serverless, zero-admin; queries CSV/Parquet directly, no import. **Single writer at a time** — not for high-concurrency multi-user OLTP. ~13× faster than an indexed Postgres 16.4 aggregation in one benchmark.
- **Postgres:** server-based; production concurrent OLTP + decent OLAP with indexes; **PostgreSQL license (permissive)**. The right call when many agents/services write concurrently or you need a durable shared store.
- **2026 consensus:** complementary. DuckDB for analytics, SQLite for edge, Postgres for production/concurrency. A common shape: SQLite/Postgres as system-of-record, **DuckDB as the analytics/scoring engine** over Parquet + pulled rows.
- Sources: https://motherduck.com/learn/duckdb-vs-postgres-embedded-analytics/ , https://kestra.io/blogs/embedded-databases , https://builder.ai2sql.io/blog/duckdb-vs-sqlite-vs-postgresql , https://duckdblab.org/en/post/duckdb-vs-sqlite-benchmark/

### LLM-as-scorer — Claude scoring an account from context
- **Pattern:** feed firmographics + engagement signals into Claude; it returns a rubric-scored verdict. Documented Claude account-targeting flow buckets accounts as **STRONG FIT / FIT / PARTIAL FIT / DISQUALIFIED** (core ICP criteria + signal).
- **Method:** LLM-as-judge with **chain-of-thought before the score** (G-Eval style: reason through explicit eval steps, then emit a structured score). Require the judge to reason first, output structured JSON.
- **Quality:** strong LLM judges reach **80–90% agreement with human evaluators** — comparable to human inter-annotator agreement. Use the most capable model you can afford for judging; Claude Sonnet 4.5 cited top-tier for subjective rubrics.
- **Fit for us:** this is the **cold-start scorer** (works with zero training data, gives a natural-language *rationale* an agent can act on) and complements the ML model (which needs labels). Native to a Claude-agent stack.
- Sources: https://www.lusha.com/blog/best-claude-prompts-account-targeting-saas-companies/ , https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge , https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method

### scikit-learn → ONNX → TS runtime (no Python at inference)
- **skl2onnx** (`sklearn-onnx`) converts a trained scikit-learn model/pipeline to an ONNX file (`to_onnx()` → `SerializeToString()`).
- **onnxruntime-node** runs that ONNX model **inside Node/TS** — so training is a one-off Python job, but *inference* needs no Python sidecar. Model artifact is small (fits well under serverless limits).
- **Consequence for the interface:** the ML scorer can be a pure-TS provider at runtime (load `.onnx`, `predict_proba`), keeping the whole hot path in the TS workflow runtime.
- Sources: https://onnx.ai/sklearn-onnx/ , https://github.com/onnx/sklearn-onnx , https://onnxruntime.ai/docs/
