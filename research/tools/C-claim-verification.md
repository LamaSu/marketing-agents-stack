# C — Claim Verification & Brand/Content Compliance (OSS techniques)

> Research in progress. Recommendation lands at the end (see "DEFAULT v1 design").

## Progress
- [x] Guardrails AI
- [x] NeMo Guardrails
- [x] Pydantic validation (Instructor / Zod-TS)
- [x] NLI / entailment models (DeBERTa-MNLI, AlignScore, SummaC, MiniCheck)
- [ ] Claim/fact extraction
- [x] OSS embeddings (BGE, E5, nomic, gte, Qwen3) + MTEB
- [x] Vector stores (Qdrant, Chroma, LanceDB, pgvector)
- [x] Citation-checking (RAGAS faithfulness)
- [ ] PII / secret scanners (Presidio, gitleaks, detect-secrets)
- [ ] Eval harnesses (promptfoo, DeepEval, RAGAS, TruLens)
- [ ] DEFAULT v1 design

---

## 1. Guardrails AI — guardrail framework
- **What**: Python framework that runs Input/Output "Guards" around an LLM. Ships **Guardrails Hub** — 60-100+ pre-built validators (regex, competitor-mention, PII, toxicity, restrict-to-topic, quantitative-checks). Feb 2025 launched "Guardrails Index" benchmark of 24 guardrails.
- **License**: Apache-2.0. Python 3.9+. Server mode exposes an OpenAI-compatible endpoint usable from JS.
- **Slot-in**: Python sidecar. Some validators pull their own ML models (extra weight). For a TS Claude pipeline, run as a small FastAPI service or just borrow the validator ideas.
- **Verdict**: **SKIP as a dependency / MINE for ideas.** The validator taxonomy (competitor-check, restrict-to-topic, quantitative-claim) is a good checklist, but wiring a Python guard framework into a TS agent adds a process boundary for logic Claude already does well. Cherry-pick specific validators only if a deterministic backstop is needed.
- Source: https://github.com/guardrails-ai/guardrails · https://guardrailsai.com/hub

## 2. NeMo Guardrails (NVIDIA)
- **What**: Programmable guardrails for LLM conversational systems. Introduces **Colang** (dialogue-flow DSL). Five rail types: input, dialog, retrieval (RAG chunk filtering), output, execution. v0.22.0 (May 2025), ~6.5k stars.
- **License**: Apache-2.0. Python.
- **Slot-in**: Heavier, conversation/dialog-oriented. Colang is overkill for a stateless asset-review pass.
- **Verdict**: **SKIP.** Built for multi-turn chatbots with dialog rails; our task is a single-shot document review. The one relevant concept (retrieval rails = filter RAG chunks) is trivial to reproduce directly.
- Source: https://github.com/NVIDIA-NeMo/Guardrails

## 3. Instructor / Pydantic / Zod — structured-output validation
- **What**: Instructor wraps an LLM client to force schema-valid structured output built on Pydantic, with automatic validation + retries. 11k+ stars, 3M+ monthly downloads. **Multi-language: Python, TypeScript, Go, Ruby, Elixir, Rust.** Supports Anthropic Claude directly.
- **License**: MIT (Instructor). Pydantic MIT. Zod MIT.
- **Slot-in**: For a **TypeScript** Claude agent, the idiomatic path is Claude tool-use / structured output + **Zod** schemas (Anthropic TS SDK + Zod). Instructor-TS is an alternative if you want the retry-on-validation-fail wrapper. This is the backbone that makes the reviewer emit a rubric-shaped JSON verdict.
- **Verdict**: **ADOPT (Zod, TS-native).** The reviewer must return machine-checkable JSON (claims[], each with category, severity, evidence, suggested-edit). Zod schema + Claude structured output is the single highest-value, lowest-cost piece.
- Source: https://python.useinstructor.com/ · https://github.com/567-labs/instructor

## 4. NLI / entailment models — claim-vs-corpus support check
- **What**: Natural Language Inference (a.k.a. RTE) classifies a (premise, hypothesis) pair as **entailment / contradiction / neutral**. Building block for grounding: treat an approved-corpus passage as premise and the asset's claim as hypothesis → "is this claim supported?" `neutral`/`contradiction` against every retrieved passage ⇒ uncited/unsupported claim.
- **Models & licenses**:
  - `DeBERTa-v3-large-mnli` (~88% MNLI). MoritzLaurer/khalidalt HF fine-tunes: **MIT/Apache-2.0**. `-base`/`-small` run on CPU.
  - **AlignScore** (355M) — unified alignment function aggregating NLI + factuality supervision; matches/beats GPT-4-based metrics at a fraction of size. Repo: github.com/yuh-zha/AlignScore.
  - **SummaC** — aggregates sentence-level NLI entailment for doc-vs-summary consistency (classic, light).
  - **MiniCheck** — small LM (≤7B, also a 400M-class flan-t5 variant) fine-tuned specifically for **claim-vs-grounding-document** checking; competitive with GPT-4 on **LLM-AggreFact** at a fraction of cost. This is the closest off-the-shelf match to our exact task.
- **Slot-in**: Python sidecar (HF `transformers`, or ONNX for CPU). One call per (claim, top-k passages).
- **Verdict**: **EXTEND (optional, phase-2 backstop).** Not needed for v1 correctness — Claude with retrieved passages judges entailment well. Add MiniCheck/DeBERTa-NLI as a cheap deterministic second opinion when you want a defensible, model-independent "unsupported claim" score that doesn't depend on Claude self-grading.
- Source: https://huggingface.co/khalidalt/DeBERTa-v3-large-mnli · https://github.com/yuh-zha/AlignScore · MiniCheck (LLM-AggreFact) via arXiv:2404.10774

## 5. OSS embeddings (for RAG over the approved-messaging corpus)
- **What / MTEB standings (2025-26)**:
  - **BGE** family (BAAI) — `bge-large-en-v1.5`, `bge-m3` (100+ langs, Q1-2026), `bge-base` — the workhorse defaults. **MIT license.**
  - **E5** (intel/microsoft) `e5-large-v2`/`multilingual-e5` — **MIT.**
  - **gte** (Alibaba) `gte-large`, `gte-multilingual-base` (305M) — strong retrieval. **Apache-2.0.**
  - **Nomic Embed** v1.5/v2 — long-context (8k), fully open training data. **Apache-2.0.**
  - **Qwen3-Embedding** (0.6B/4B/8B) — tops MTEB in 2025-26. **Apache-2.0.**
  - **Jina v5-text-small** (677M, MTEB v2 ~71.7) — best quality/size. Apache-2.0.
- **Slot-in**: Two options — (a) run a small model locally via `@xenova/transformers` (ONNX, **pure TypeScript, no Python**) — `bge-small`/`gte-small`/`e5-small` all have ONNX builds; (b) Python sidecar with `sentence-transformers`. For a corpus of approved messaging (hundreds–thousands of chunks) a small model on CPU is plenty.
- **Verdict**: **ADOPT `bge-small-en-v1.5` (or `gte-small`) via `@xenova/transformers` for v1** (TS-native, MIT/Apache, CPU-fast, no sidecar). Scale up to `bge-m3`/`Qwen3` only if recall proves weak.
- Source: https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models · https://modal.com/blog/mteb-leaderboard-article

## 6. Vector stores
- **What / license**:
  - **LanceDB** — embedded, serverless, disk-based (larger-than-memory), Rust core, **has a native TypeScript/Node SDK**. **Apache-2.0.** No server to run — it's a library (like SQLite-for-vectors).
  - **Chroma** — simplest API, great DX, good to a few hundred k vectors. **Apache-2.0.** Python-first; JS client talks to a running server.
  - **Qdrant** — Rust, production-scale (5M+ vectors), rich payload filtering, official JS SDK. **Apache-2.0.** Runs as a server/container.
  - **pgvector** — Postgres extension; best if you already run Postgres; combines vector + SQL filters. **PostgreSQL (BSD-like) license.** Practical to ~10-100M vectors.
- **Slot-in**: For an approved-messaging corpus that is small and mostly static, an **embedded** store beats a server. **LanceDB** is the standout for a TS agent — `npm install @lancedb/lancedb`, no separate process, files on disk.
- **Verdict**: **ADOPT LanceDB for v1** (embedded, TS-native, zero-ops, Apache-2.0). Use **pgvector** instead only if the product already has Postgres. Qdrant if/when corpus + traffic scale into millions.
- Source: https://4xxi.com/articles/vector-database-comparison/ · https://encore.dev/articles/best-vector-databases

## 7. Citation-checking / faithfulness (RAGAS)
- **What**: RAGAS — open-source RAG eval framework. Reference-free LLM-graded metrics: **Faithfulness** (does the answer stay grounded in retrieved context?), **Answer Relevancy**, **Context Precision/Recall**. Faithfulness decomposes an answer into atomic claims and checks each against retrieved context — *exactly the claim-support pattern we need*, but framed as an eval metric. 5M+ evals/month (AWS/MS/Databricks).
- **License**: Apache-2.0. Python.
- **Slot-in**: Python sidecar, used at **eval time** (grade the reviewer), not necessarily in the live path. Its "decompose into atomic claims → check each against context" recipe is a blueprint we implement directly with Claude for the live reviewer.
- **Verdict**: **ADOPT for the eval harness (Python sidecar); borrow the claim-decomposition pattern for the live reviewer.** Don't put RAGAS in the request path.
- Source: https://www.ragas.io/ · https://docs.ragas.io/

---

_(remaining sections: claim extraction, PII/secret scanners, eval harnesses, DEFAULT v1 design — in progress)_
