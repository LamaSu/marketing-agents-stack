# C — Claim Verification & Brand/Content Compliance (OSS techniques)

Research for the **asset-review / claim-drift agent**: ingest a partner marketing asset →
extract claims → check each against an approved-messaging corpus + brand rule-set →
flag categories → score on a rubric → draft edits. Claude does the reasoning; the OSS
below adds *robustness, determinism, and gradeability*.

---

## TL;DR — recommendation

**v1 is Claude + a tiny TS-native RAG + Zod. Do not adopt a Python guardrail
framework.** The whole live path stays in TypeScript:

- **Claude (Anthropic SDK) + Zod** — claim extraction, per-category judgment, rubric score,
  and edit drafting, emitted as a **Zod-validated JSON** verdict. This is the engine.
- **`@xenova/transformers` (Transformers.js) + `@lancedb/lancedb`** — embed the
  approved-messaging corpus with `bge-small-en-v1.5` and retrieve top-k per claim. Both
  run **in-process in Node on Windows**, no Python, no server.
- **A deterministic rule layer** (lexicons/regex + allowlists) for the mechanical
  categories (banned superlatives, guarantee words, spokesperson allowlist, badge/tier map,
  roadmap deny-list) so those never depend on model judgment.
- **promptfoo** (MIT, TypeScript) as the eval harness to grade reviewer quality.

**Phase-2 Python sidecars (only when you want model-independent evidence):** a small **NLI /
MiniCheck** entailment check as a second opinion on "unsupported claim", **Microsoft Presidio**
for PII, and **RAGAS** for retrieval-faithfulness scoring in CI. **gitleaks** (CLI) +
custom deny-lists cover secret/roadmap leakage.

### Verdict table

| Tool | Category | License | TS-native? | Verdict |
|------|----------|---------|-----------|---------|
| **Anthropic SDK + Zod** | structured output / validation | MIT | ✅ | **ADOPT** (core engine) |
| **Transformers.js** (`@xenova/transformers`) | OSS embeddings + optional NLI (ONNX) | Apache-2.0 | ✅ | **ADOPT** (embeddings) |
| **LanceDB** (`@lancedb/lancedb`) | embedded vector store | Apache-2.0 | ✅ (Win/mac/linux) | **ADOPT** (corpus RAG) |
| **promptfoo** | eval harness | MIT | ✅ | **ADOPT** (grading) |
| **Deterministic rule layer** (lexicon/regex, home-grown) | brand rule-set | n/a | ✅ | **ADOPT** (mechanical categories) |
| **gitleaks** | secret scanner (CLI) | MIT | CLI | **ADOPT** (leak backstop) |
| **NLI / MiniCheck / AlignScore** | entailment claim-support | MIT/Apache (verify per repo) | via Transformers.js or Py | **EXTEND** (phase-2 backstop) |
| **Microsoft Presidio** | PII detection/redaction | Apache-2.0 | Python sidecar | **EXTEND** (if PII in scope) |
| **RAGAS** | RAG faithfulness eval | Apache-2.0 | Python sidecar | **EXTEND** (CI faithfulness) |
| **Guardrails AI** | guardrail framework | Apache-2.0 | Py (JS via server) | **SKIP** (mine validator ideas) |
| **NeMo Guardrails** | dialog guardrails | Apache-2.0 | Python | **SKIP** (dialog-oriented) |
| **DeepEval** | eval harness | Apache-2.0 | Python | **SKIP** (use promptfoo in TS) |
| **FacTool / ClaimBuster / OpenFactCheck** | claim extraction/fact-check | MIT/Apache | Python | **SKIP** as dep (borrow FacTool's 5-stage pattern) |
| **TruffleHog / detect-secrets** | secret scanner | AGPL-3.0 / Apache-2.0 | CLI | **SKIP** (gitleaks covers it; AGPL if embedding) |

Licenses marked "verify per repo/checkpoint" were not pinned to an exact SPDX string in
search results — confirm on the specific GitHub repo / HF model card before shipping.

---

## 1. Guardrails AI — guardrail framework
- **What**: Python framework running Input/Output "Guards" around an LLM. **Guardrails Hub**
  = 60-100+ pre-built validators (competitor-mention, restrict-to-topic, PII, toxicity,
  quantitative checks, regex). Feb-2025 "Guardrails Index" benchmarked 24 guardrails.
- **License**: Apache-2.0. Python 3.9+. A server mode exposes an OpenAI-compatible endpoint.
- **Slot-in**: Python sidecar; several validators pull their own ML models (weight). Usable
  from JS only through the HTTP server.
- **Verdict**: **SKIP as a dependency; MINE the validator taxonomy.** Its category list
  (competitor-check, restrict-to-topic, quantitative-claim, "provenance"/citation validators)
  is a good checklist for our rule layer, but running a Python guard framework beside a TS
  agent adds a process boundary for logic Claude already does. Cherry-pick a validator only
  where a hard deterministic gate is wanted.
- Source: https://github.com/guardrails-ai/guardrails · https://guardrailsai.com/hub

## 2. NeMo Guardrails (NVIDIA)
- **What**: Programmable guardrails for LLM *conversational* systems. Introduces **Colang**
  (dialogue-flow DSL). Five rail types: input, dialog, retrieval (RAG-chunk filtering),
  output, execution. v0.22.0 (May 2025), ~6.5k stars.
- **License**: Apache-2.0. Python.
- **Slot-in**: Heavy, multi-turn-oriented; Colang is overkill for a single-shot document review.
- **Verdict**: **SKIP.** Built for chatbots with dialog state. The one relevant idea —
  "retrieval rails" filter RAG chunks before use — is a two-line filter we implement directly.
- Source: https://github.com/NVIDIA-NeMo/Guardrails

## 3. Instructor / Pydantic / Zod — structured-output validation
- **What**: Instructor wraps an LLM client to force schema-valid structured output (Pydantic)
  with auto-validation + retry. 11k+ stars, 3M+ monthly downloads, **multi-language: Python,
  TypeScript, Go, Ruby, Elixir, Rust**; supports Claude directly. The TS ecosystem's idiomatic
  form is **Zod** schemas + the model's structured-output / tool-use mode.
- **License**: Instructor MIT · Pydantic MIT · Zod MIT.
- **Slot-in**: In a **TypeScript** Claude agent, define the reviewer's output as a **Zod
  schema** (`claims[]`: text, span, category enum, severity, supporting-passage-id | null,
  suggested-edit; plus a rubric block) and use Claude's structured output; re-ask on a Zod
  parse failure. Instructor-TS is optional sugar for the retry loop.
- **Verdict**: **ADOPT (Zod, TS-native).** A machine-checkable, schema-valid verdict is the
  single highest-value / lowest-cost piece — it's what makes the reviewer's output pipeline-
  able, diffable, and gradeable.
- Source: https://python.useinstructor.com/ · https://github.com/567-labs/instructor

## 4. NLI / entailment models — claim-vs-corpus support check
- **What**: Natural Language Inference (RTE) labels a (premise, hypothesis) pair
  **entailment / contradiction / neutral**. The grounding move: premise = an approved-corpus
  passage, hypothesis = the asset's claim → if *no* retrieved passage entails a claim, that
  claim is **uncited / unsupported** (drift). This is a deterministic, model-independent
  backstop to Claude's judgment.
- **Models & licenses**:
  - `DeBERTa-v3-large-mnli` (~88% MNLI); `-base`/`-small` run on CPU. MoritzLaurer / khalidalt
    HF NLI fine-tunes are **MIT/Apache-2.0**; there are **ONNX builds usable from
    Transformers.js** (zero-shot-classification pipeline) — so this can run **in TS**.
  - **AlignScore** (355M) — unified alignment fn (NLI + factuality); rivals GPT-4-based
    metrics at a fraction of size. Repo `yuh-zha/AlignScore` (OSS; verify license).
  - **SummaC** — aggregates sentence-level NLI entailment; classic, light.
  - **MiniCheck** — small LM (a ~400M flan-t5 variant + ≤7B) fine-tuned *specifically* for
    **claim-vs-grounding-document** checking; competitive with GPT-4 on **LLM-AggreFact** at
    a fraction of cost. **Closest off-the-shelf match to our exact task.** Repo `Liyan06/MiniCheck`
    (verify license before shipping).
- **Slot-in**: (a) TS-native zero-shot NLI via Transformers.js for `-base`/`-small` DeBERTa;
  (b) Python sidecar (`transformers`) for MiniCheck/AlignScore. One call per (claim, top-k
  passages); take max entailment prob as the support score.
- **Verdict**: **EXTEND (phase-2 backstop).** Not required for v1 — Claude, given the
  retrieved passages, judges support well and returns the evidence id. Add MiniCheck (or
  DeBERTa-NLI) when you want a defensible, model-independent "unsupported-claim" score that
  doesn't rely on Claude grading itself — useful for audit and for the eval set's ground truth.
- Source: https://huggingface.co/khalidalt/DeBERTa-v3-large-mnli · https://github.com/yuh-zha/AlignScore · MiniCheck: arXiv:2404.10774 (LLM-AggreFact)

## 5. Claim / fact extraction
- **What**: Splitting a document into atomic, check-worthy factual claims.
  - **FacTool** — 5-stage tool-augmented factuality framework: **claim extraction → query
    generation → tool querying → evidence collection → agreement verification**. The claim-
    extraction stage is *itself an LLM prompt* keyed to a claim definition. This is the exact
    decomposition our Claude prompt should follow.
  - **ClaimBuster** — "claim spotter" classifies each sentence as (1) check-worthy factual
    claim, (2) unimportant factual claim, (3) non-factual. Good taxonomy for the "which
    sentences even need checking" pre-filter.
  - **OpenFactCheck** — open-source Python library / unified framework for LLM factuality
    (customizable fact-checkers + benchmarking).
- **License**: FacTool MIT · OpenFactCheck open-source (Python) · ClaimBuster (research/API).
- **Slot-in**: Python if adopted wholesale; but the **claim-extraction + check-worthiness**
  steps are a single Claude structured-output call in our TS path.
- **Verdict**: **SKIP as dependencies; BORROW FacTool's 5-stage pattern** as the shape of the
  Claude prompt (extract → for each claim, retrieve evidence → verify agreement → report). No
  need to add a Python fact-check framework when Claude + our RAG already provide extraction
  and evidence retrieval.
- Source: https://arxiv.org/pdf/2307.13528 (FacTool) · https://dl.acm.org/doi/10.1145/3097983.3098131 (ClaimBuster) · https://openfactcheck.com/

## 6. OSS embeddings (RAG over the approved-messaging corpus)
- **What / MTEB standings (2025-26)**: **BGE** (BAAI) `bge-small/base/large-en-v1.5`,
  `bge-m3` (100+ langs) — **MIT**, the workhorse defaults · **E5** `e5-*`/`multilingual-e5`
  — **MIT** · **gte** (Alibaba) `gte-small/large`, `gte-multilingual-base` — **Apache-2.0** ·
  **Nomic Embed** v1.5/v2 (8k context, open data) — **Apache-2.0** · **Qwen3-Embedding**
  (0.6/4/8B, tops MTEB) — **Apache-2.0** · **Jina v5-text-small** (677M, best quality/size) —
  **Apache-2.0**. (Confirm the exact license on each HF model card.)
- **Slot-in**: **TS-native** via `@xenova/transformers` (ONNX; `bge-small`/`gte-small`/
  `all-MiniLM-L6-v2` have ready ONNX builds, now runs in Node/Bun/Deno) — no Python; or a
  Python `sentence-transformers` sidecar for the big models. An approved-messaging corpus is
  small (hundreds–low-thousands of chunks), so a small CPU model is plenty and sub-second.
- **Verdict**: **ADOPT `bge-small-en-v1.5` (or `gte-small`) via Transformers.js for v1** —
  MIT/Apache, CPU-fast, no sidecar. Scale to `bge-m3`/`Qwen3-Embedding` only if recall proves
  weak on real assets.
- Source: https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models · https://modal.com/blog/mteb-leaderboard-article

## 7. Vector stores
- **What / license**:
  - **LanceDB** — **embedded**, serverless, disk-based (larger-than-memory), Rust core,
    **native Node/TS SDK** (`npm i @lancedb/lancedb`), prebuilt binaries incl. **Windows
    x86_64 + aarch64**, mac, linux. Vector + full-text + SQL filter. **Apache-2.0.** No
    process to run — SQLite-for-vectors.
  - **Chroma** — simplest API; Python-first, JS client talks to a running server. Good to a
    few hundred k vectors. **Apache-2.0.**
  - **Qdrant** — Rust, production-scale (5M+), rich payload filtering, official JS SDK; runs
    as a server/container. **Apache-2.0.**
  - **pgvector** — Postgres extension; best when you already run Postgres (vector + SQL in one
    place); practical to ~10-100M vectors. **PostgreSQL (BSD-like) license.**
- **Slot-in**: A static, smallish approved corpus wants an **embedded** store, not a server.
  **LanceDB** fits a TS agent perfectly: in-process, files on disk, Windows binaries.
- **Verdict**: **ADOPT LanceDB for v1** (embedded, TS-native, zero-ops, Windows-supported).
  Use **pgvector** instead only if the product already runs Postgres; **Qdrant** when corpus
  + traffic reach millions.
- Source: https://github.com/lancedb/lancedb · https://www.npmjs.com/package/@lancedb/lancedb · https://4xxi.com/articles/vector-database-comparison/

## 8. Citation-checking / faithfulness (RAGAS) + eval harnesses
- **RAGAS** — OSS RAG-eval framework. Reference-free LLM-graded metrics: **Faithfulness**
  (decomposes an answer into atomic claims, checks each against retrieved context — *exactly
  our claim-support pattern*), **Answer Relevancy**, **Context Precision/Recall**. 5M+
  evals/month (AWS/MS/Databricks). **Apache-2.0**, Python.
  - **Verdict**: **EXTEND — use at eval time, not in the request path.** Its
    decompose-into-atomic-claims → check-against-context recipe is the blueprint we implement
    directly with Claude for the live reviewer; run RAGAS itself in CI to score whether the
    reviewer's grounding is faithful. Source: https://www.ragas.io/ · https://docs.ragas.io/
- **promptfoo** — **TypeScript** (MIT), 350k+ devs. YAML/JS test cases with assertions:
  exact/substring, **JSON-schema**, semantic similarity, and **LLM-graded rubrics**; strong
  red-team engine. Runs evals in the *same language as the agent*.
  - **Verdict**: **ADOPT** — the eval harness for reviewer quality (precision/recall of each
    flag category, rubric-score agreement vs. a labeled asset set). Source: https://www.promptfoo.dev/
- **DeepEval** — Python (Apache-2.0), pytest-native, 50+ metrics (G-Eval, hallucination,
  faithfulness, contextual recall).
  - **Verdict**: **SKIP** for this TS pipeline (use promptfoo); reach for it only if the team
    prefers pytest/Python evals with research-backed metrics. Source: https://scrolltest.com/deepeval-vs-promptfoo-llm-evaluation-framework-2026/

## 9. PII / secret / leakage scanners
- **Microsoft Presidio** — OSS framework to **detect, redact, mask, anonymize PII** across
  text/images/structured data. NER (spaCy) + pattern-matching + custom recognizers; analyzer
  returns typed spans (PERSON, PHONE_NUMBER, EMAIL, CREDIT_CARD, …) with scores. **Apache-2.0**,
  Python (Docker/K8s deployable).
  - **Verdict**: **EXTEND (adopt as sidecar if PII is in scope).** The demo's named categories
    don't include PII, but a partner asset leaking customer/employee PII is a real safety net.
    De-facto standard; run as a small FastAPI sidecar, flag spans, let Claude weigh severity.
    Source: https://github.com/microsoft/presidio
- **gitleaks** — fast regex secret scanner, MIT, ideal as a CLI gate (API keys, tokens).
  **TruffleHog** — deeper (800+ types, S3/Docker/Slack) and **verifies** if a credential is
  live, but recent versions are **AGPL-3.0** (copyleft — matters if you embed it).
  **detect-secrets** (Yelp) — Apache-2.0, entropy + plugins.
  - **Verdict**: **ADOPT gitleaks** (MIT, fast, CLI) as the secret backstop; **SKIP**
    TruffleHog/detect-secrets for v1 (gitleaks covers the need; avoid AGPL if embedding). For
    the **roadmap/unannounced-product** category, the higher-value tool is a **custom
    deny-list** (internal codenames, unreleased SKUs, "confidential"/"NDA" markers) run as
    regex — the same scanning mindset, project-specific terms. Source: https://github.com/gitleaks/gitleaks

---

## DEFAULT design for v1

**Principle: Claude is the reviewer; OSS makes it grounded, deterministic where it should be,
and gradeable. Keep the live path in TypeScript; push heavy ML to optional Python sidecars.**

### Two inputs, two mechanisms
- **Approved-messaging corpus → RAG.** What *may* be said / what's already approved. Powers
  "is this claim supported / on-message?" (retrieval + entailment).
- **Brand rule-set → deterministic layer + Claude prompt.** Banned-superlative lexicon,
  guarantee-word lexicon, spokesperson **allowlist** (+ approved-quote corpus), badge/partner-
  **tier map**, roadmap/codename **deny-list**. Mechanical categories should never depend on
  model mood.

### Pipeline (per asset)
1. **Ingest & segment** (TS) — normalize the asset to text + spans (sentences/blocks).
2. **Deterministic pre-scan** (TS) — lexicon/regex passes flag the mechanical categories
   immediately: guarantee words ("guaranteed", "risk-free", "100%"), banned superlatives
   ("#1", "best-in-class", "fastest"), badge/tier strings, roadmap/codename deny-list, plus a
   **gitleaks** secret pass. Cheap, precise, model-independent. Each hit → candidate finding.
3. **Claim extraction** (Claude, Zod) — FacTool-style: extract atomic claims, tag each with
   `category` (guaranteed-outcome | uncited-quantitative | unapproved-superlative |
   unapproved-spokesperson-quote | roadmap-disclosure | badge-tier-misuse) and
   `check_worthy`.
4. **Retrieve** (TS) — for each check-worthy claim, embed with **bge-small** (Transformers.js)
   and pull top-k from the approved corpus in **LanceDB**. Quotes are matched against the
   approved-quote corpus; spokespeople against the allowlist.
5. **Judge & ground** (Claude, Zod) — with the retrieved passages + brand rules in context,
   Claude decides per claim: `supported | drifted | unsupported`, sets `severity`, cites the
   `supporting_passage_id` (or null), and drafts a `suggested_edit`. Deterministic findings
   from step 2 are merged in as high-confidence priors.
6. *(phase-2)* **Entailment backstop** (sidecar) — for every "unsupported/drifted" claim, run
   **MiniCheck / DeBERTa-NLI** over (claim, top-k passages). Disagreement with Claude →
   `needs_review` flag. Model-independent evidence for audit.
7. *(optional)* **PII pass** — **Presidio** sidecar flags PII spans.
8. **Score & emit** — Claude fills a **Zod-validated** rubric JSON (per-category counts,
   weighted risk score, overall verdict, `findings[]` with evidence + edits). Zod parse failure
   → one bounded re-ask.
9. **Eval loop (offline/CI)** — **promptfoo** grades reviewer output vs. a labeled asset set
   (per-category precision/recall, rubric agreement); **RAGAS Faithfulness** scores whether
   step 5's judgments stay grounded in retrieved context. These gate prompt/threshold changes.

### Concrete packages (v1, TypeScript)
- `@anthropic-ai/sdk` — Claude (extraction, judgment, scoring, edits). **MIT**
- `zod` — schema for the reviewer's structured verdict + rubric. **MIT**
- `@xenova/transformers` — `bge-small-en-v1.5` embeddings (ONNX, in-process, Windows). **Apache-2.0**
- `@lancedb/lancedb` — embedded vector store for the approved corpus (Windows binaries). **Apache-2.0**
- `gitleaks` (CLI) — secret backstop; **plus a home-grown regex deny-list** for roadmap/codenames. **MIT**
- `promptfoo` (devDependency) — eval harness in the agent's own language. **MIT**

### Phase-2 Python sidecars (add only when model-independent evidence is needed)
- **MiniCheck** *or* `DeBERTa-v3-base-mnli` — entailment backstop for "unsupported" claims.
  (DeBERTa-base can even stay in TS via Transformers.js if you want zero Python.)
- **Microsoft Presidio** — PII detection/redaction. **Apache-2.0**
- **RAGAS** — retrieval-faithfulness scoring in CI. **Apache-2.0**

### What we deliberately did NOT adopt
Guardrails AI and NeMo Guardrails (Python frameworks whose value here is a validator
*checklist*, not a runtime dependency); DeepEval (Python — promptfoo covers TS); FacTool/
ClaimBuster/OpenFactCheck as libraries (we reuse FacTool's 5-stage *pattern* in a Claude
prompt); TruffleHog/detect-secrets (gitleaks suffices; TruffleHog's AGPL-3.0 is a copyleft
snag if embedded). Each adds a process boundary or a copyleft/licensing cost that Claude +
a small TS RAG already covers.

---

### Sources
- Guardrails AI: https://github.com/guardrails-ai/guardrails · https://guardrailsai.com/hub
- NeMo Guardrails: https://github.com/NVIDIA-NeMo/Guardrails
- Instructor / structured output: https://python.useinstructor.com/ · https://github.com/567-labs/instructor
- NLI / DeBERTa-MNLI: https://huggingface.co/khalidalt/DeBERTa-v3-large-mnli · https://nlp.stanford.edu/projects/snli/
- AlignScore: https://github.com/yuh-zha/AlignScore · MiniCheck: https://arxiv.org/pdf/2404.10774
- Claim extraction (FacTool): https://arxiv.org/pdf/2307.13528 · ClaimBuster: https://dl.acm.org/doi/10.1145/3097983.3098131 · OpenFactCheck: https://openfactcheck.com/
- Embeddings / MTEB: https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models · https://modal.com/blog/mteb-leaderboard-article
- Vector stores: https://github.com/lancedb/lancedb · https://www.npmjs.com/package/@lancedb/lancedb · https://4xxi.com/articles/vector-database-comparison/
- RAGAS: https://www.ragas.io/ · https://docs.ragas.io/
- promptfoo / DeepEval: https://www.promptfoo.dev/ · https://scrolltest.com/deepeval-vs-promptfoo-llm-evaluation-framework-2026/
- Presidio: https://github.com/microsoft/presidio
- Secret scanners: https://github.com/gitleaks/gitleaks · https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools
- Transformers.js: https://github.com/xenova/transformers.js · https://www.npmjs.com/package/@xenova/transformers
