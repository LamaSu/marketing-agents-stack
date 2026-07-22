# @mstack/reviewer

Corpus + deterministic-rule layer for the Asset-Review / Claim-Drift agent
(research/06-architecture.md §3.1, §7 W2-T4). This is Wave 2 scope only: the
RAG corpus and the mechanical pre-scan. The Claude agent pipeline (extract →
retrieve → judge → score) is Wave 3, built in `packages/agents` on top of the
two entry points below — see the `TODO(wave3)` markers in `src/index.ts`,
`src/rules.ts`, and `src/lance-corpus.ts` for exactly where it plugs in. No
Anthropic SDK call, prompt, or Zod-reask loop lives in this package.

## What's here

- **`LanceCorpus`** (`lance-corpus.ts`) — implements the `GuidelineCorpus` seam
  (`packages/core/src/seams.ts`): `ingest()` embeds `type: "approved_messaging"`
  guideline rows into LanceDB, `retrieve(query, k)` returns top-k similar
  passages, `rules()` returns the non-embedded rule rows (lexicon/allowlist/
  denylist/tier_map) as-is.
- **`Embedder`** (`embedder.ts`) — the injectable embedding seam:
  `interface Embedder { embed(texts: string[]): Promise<number[][]> }`.
  Two implementations: `FakeEmbedder` (deterministic hashing-trick
  bag-of-words, offline, what every test here uses) and `HuggingFaceEmbedder`
  (real `bge-small-en-v1.5` via `@huggingface/transformers`, lazy-loaded, used
  by the `createLanceCorpus()` factory's default).
- **`scanDeterministic`** (`rules.ts`) — the mechanical pre-scan: asset text +
  partner tier + `Guideline[]` → candidate `FindingDraft[]` for the seven
  `ClaimCategory` values (the original six, plus `pii_leak` added Wave B2),
  every one `detectedBy: "deterministic"`.
- **`NliBackstop`** (`nli-backstop.ts`, Wave B2) — the injectable grounded-NLI
  seam `review-agent.ts`'s judge step calls for every finding it produces:
  `noopNliBackstop` (default, offline, always agrees) and `createHhemBackstop`/
  `hhemBackstop` (opt-in Vectara HHEM-2.1-Open sidecar — `docker/hhem.md`).
- **`corpus-loader.ts`** — reads `data/corpus/guidelines.json` +
  `data/corpus/approved-messaging.md` (chunked by `##` section) into a
  combined `Guideline[]`, and `data/corpus/assets/assets.json` into
  `ReviewRequest[]`.

## Package name note (`@huggingface/transformers`, not `@xenova/transformers`)

`research/tools/C-claim-verification.md` names `@xenova/transformers`. Verified
live against the npm registry (2026-07-20): `@xenova/transformers` is frozen at
`2.17.2` (Xenova transferred Transformers.js to Hugging Face); `@huggingface/transformers`
is the actively maintained successor, currently `4.2.0`. This package depends
on `@huggingface/transformers`. See the file-header comment in `embedder.ts`
for the full verification trail (package identity + the exact
`pipeline`/`.tolist()` API shape, both confirmed against the package's own
shipped `.d.ts` files, not by running the code — this package was written
without a local `pnpm install`, per `docs/build-conventions.md`).

## Which categories the deterministic layer catches (vs what needs Wave 3)

Verified against the real sample corpus (`data/corpus/`) in `rules.test.ts`:

| Category | Mechanism | Confidence |
|---|---|---|
| `guaranteed_outcome` | data-driven: quoted lexicon terms (`guarantee`, `ensures`, `promise`, `risk-free`, ...) extracted from `type:"lexicon"` guideline rows, matched with simple inflection tolerance | high — literal/near-literal bans |
| `unapproved_superlative` | data-driven lexicon terms (`best-in-class`, `unmatched`, `unrivaled`, `#1`, `world's best`) **+** a structural `"no other platform/partner/solution/vendor ..."` regex (added because the corpus's planted violations paraphrase the guideline's example phrase rather than quote it) | high for the literal terms; medium for the comparative pattern (English has many ways to phrase this) |
| `unapproved_spokesperson_quote` | data-driven: approved-spokesperson names extracted from `type:"allowlist"` guideline prose, matched against quoted-text + `"...," said NAME`-style attribution found in the asset | medium — a real but best-effort attribution heuristic, not a full NLP parse; novel attribution phrasing needs the Wave-3 judge |
| `roadmap_disclosure` | data-driven: quoted denylist terms (codenames, product names) **+** a structural forward-looking-date pattern (`Q# 20XX` near a trigger word like "will be launching") | high for literal codenames; the date pattern is deliberately conservative (favors precision — see `rules.ts` §5) since the literal-term path already covers recall on the fixture |
| `badge_tier_misuse` | a small structural table encoding the corpus's `tier_map` guideline rows (badge string → required `PartnerTier`) | high, but only for badges known to the table — see the table's comment for how to extend it |
| `uncited_quantitative` | **bonus, best-effort**: a numeric-shape regex (`%`, `Nx`, `$amount`) plus a citation-marker window search (~250 chars either side) | **lowest confidence of the six** — a citation-window heuristic can both over- and under-suppress; this is the category the Wave-3 Claude judge should double-check or override most readily |
| `pii_leak` (Wave B2) | **always-on inline regex** (`scanPii`): email addresses, SSNs, phone numbers, credit-card numbers — precision-favoring delimited shapes, not bare digit runs. Opt-in `presidioScan` sidecar trades precision for Presidio's NER-based recall (never called by `scanDeterministic` by default). | high precision, deliberately conservative recall for the offline default — same trade-off as the inline secret pass below |

Everything this layer emits is a **prior**, not a verdict — `research/06-architecture.md`
§3.1 step 5 explicitly has the Claude judge merge deterministic findings in
rather than trust them blindly. This layer's job is precision on the
mechanical cases, not full recall on everything a human reviewer would catch
(novel phrasing, implied claims, tone) — that's what the judge step is for.

A secret/roadmap regex pass also runs inline by default (AWS keys, generic
API-key assignments, Slack tokens, private-key blocks) — mapped onto
`roadmap_disclosure` since `ClaimCategory` has no dedicated secret-leak value
(see the "8. inline secret pass" section of `rules.ts` for that judgment
call). The real `gitleaks` CLI is wired as an explicit, OPT-IN backstop
(`runGitleaksIfAvailable`), never called by default — it gracefully returns
`[]` if the binary isn't installed.

**Wave B2** (`research/10-sota-integration-design.md` §2.2) added two pieces,
both offline-safe by default:

1. **`pii_leak` category + `scanPii`** — unlike the secret pass above, PII gets
   its own dedicated `ClaimCategory` value (additive to core's enum). The
   always-on inline regex pass is the offline default; `presidioScan(text,
   {url})` is an explicit, OPT-IN Presidio (MIT, Python) sidecar for higher
   recall — same graceful-degradation discipline as `runGitleaksIfAvailable`
   (resolves its URL from an argument or `PRESIDIO_URL`; with neither set it
   returns `[]` with zero network attempts).
2. **Grounded-NLI backstop** (`nli-backstop.ts`) — a second, model-independent
   opinion the judge step (`review-agent.ts`) calls on every finding it
   produces. Default `noopNliBackstop` always agrees with the judge (fully
   offline, no sidecar); `createHhemBackstop`/`hhemBackstop` is the opt-in
   Vectara HHEM-2.1-Open sidecar (`docker/hhem.md` has the run command). On
   disagreement, `reviewAsset`'s output re-attributes the finding
   `detectedBy: "nli"` and adds `needsReview: true` — an additive,
   optional field (`ReviewResultWithNli`/`NliFindingDraft` in
   `review-agent.ts`), never a change to core's `ReviewResult`/`FindingDraft`
   shape, so guardrail #1 (no generated-prose field) is untouched.

## Tests are fully offline

Every test uses `FakeEmbedder` (deterministic hashing-trick bag-of-words —
`embedder.ts`) and a real temporary directory for LanceDB (`fs.mkdtemp`, no
in-memory URI scheme confirmed for this LanceDB client version). No test
constructs-and-calls `HuggingFaceEmbedder` — that would require a network call
and an ONNX model download, which `docs/build-conventions.md` rules out for
this repo's dev environment. `HuggingFaceEmbedder`'s correctness against a
real model is a Wave-3 / live-smoke-test concern.

```bash
pnpm --filter @mstack/reviewer test        # vitest run — offline, no network
pnpm --filter @mstack/reviewer typecheck   # tsc --noEmit
```

Per `docs/build-conventions.md`, these were not run locally while writing this
package (the dev tablet OOMs on `@lancedb/lancedb`'s native binary + this
package's other deps) — they run on Spark as part of the wave's consolidated
`pnpm install && pnpm -r build && pnpm -r test`.
