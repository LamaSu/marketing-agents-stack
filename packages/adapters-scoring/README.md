# @mstack/adapters-scoring

`ScoringProvider` implementations for the noise-filter step ahead of the account-intel
swarm (research/06-architecture.md §3.2). No OSS MadKudu/Pocus exists to adopt
(research/tools/D-warehouse-scoring.md) -- composing rules + LLM + ONNX behind one seam
**is** the contribution.

- **`RulesScorer`** -- the always-on, zero-dependency, fully offline floor. Weighted
  firmographic + signal rules -> 0-100, with hard disqualifiers (e.g. an `unsubscribed`
  signal) that force `DISQUALIFIED` regardless of everything else. `rationale` lists
  every rule that fired. Also reports the blend's two components on `ScoreResult` --
  `fit` (firmographic/technographic only) and `intent` (behavioral signals, exponentially
  time-decayed by age -- ~90-day half-life, see `decayWeight()` in `rules-scorer.ts`) --
  both optional and additive, so callers that only read `score` are unaffected.
- **`ClaudeScorer`** -- cold-start scoring with zero training data, via
  `@anthropic-ai/sdk`. The `Anthropic` client is **injectable** (`new ClaudeScorer({
  client })`); when omitted, one is constructed lazily on first use (never at import or
  construction), so an un-injected `ClaudeScorer` never breaks an otherwise-offline
  process until something actually calls `.score()`. Uses `messages.parse()` +
  `zodOutputFormat()` (structured outputs) -- the API constrains generation to the
  schema, so there is no hand-rolled reask loop.
- **`OnnxScorer`** -- optional ML scorer over a model trained offline by `train/`. If
  `train/model.onnx` doesn't exist (the default, until you train one), `available` is
  `false` and the scorer disables gracefully -- never throws at import or construction.
- **`HybridScorer`** (the default) -- `max(rulesScore, weighted(onnx, claude))`, per
  research/tools/D-warehouse-scoring.md's blend formula, with the contributing scorers'
  rationale always attached. Rules always run; Claude only runs if you inject a
  `ClaudeScorer`; Onnx runs if a model file is present. With zero configuration,
  `new HybridScorer()` degrades to Rules-only, fully offline.

## Usage

```ts
import { scoringProvider, ClaudeScorer } from "@mstack/adapters-scoring";

// Offline, zero-config -- Rules-only.
const scorer = scoringProvider(); // HybridScorer, degrades to rules
const result = await scorer.score(account, signals); // { score, tier, rationale, fit?, intent? }

// Opt into Claude cold-start scoring by injecting a client.
import Anthropic from "@anthropic-ai/sdk";
const withClaude = scoringProvider("hybrid", { claude: new ClaudeScorer({ client: new Anthropic() }) });
```

## Known simplifications

- `HybridScorer`'s blend is `max(rules, weighted(onnx, claude))`, taken directly from
  research/tools/D-warehouse-scoring.md. This means an optimistic Claude/Onnx score CAN
  numerically outrank a Rules-level disqualifier (e.g. `unsubscribed`) in the final
  blended number -- `RulesScorer` alone always honors the disqualifier as a hard
  `DISQUALIFIED`, but `HybridScorer`'s blend does not re-apply that as an unconditional
  ceiling. A workflow that needs a strict, always-wins compliance gate should check
  `RulesScorer.score(...).tier === "DISQUALIFIED"` upstream (e.g. in
  `packages/account-intel`) rather than relying on the generic blend to enforce it.
- `OnnxScorer`'s ONNX input/output tensor names (`"input"` / `"probabilities"`) are a
  contract this package's own `train/train.py` establishes and documents (see
  `train/README.md`), not a fact verified against a real trained model -- no labeled
  dataset ships with this repo, so the ONNX path has not been exercised end-to-end.
  Verify both sides together the first time a real model is trained and loaded.
- `train/calibrate.py` (probability calibration via `CalibratedClassifierCV`) reuses
  `train.py`'s exact CSV and ONNX-export contract, so a calibrated model loads into
  `OnnxScorer` unchanged -- but, like `train/train.py`, it has not been run end-to-end
  against a real dataset, and skl2onnx's `CalibratedClassifierCV` converter support has
  not been verified against the pinned `skl2onnx` version. Verify together the first
  time you actually run it (see `train/README.md`).
- Written without running `pnpm install`/`pnpm test` locally (dev tablet OOMs on native
  deps -- `docs/build-conventions.md`). `@anthropic-ai/sdk`'s `messages.parse` +
  `zodOutputFormat` usage matches the Claude API skill's documented TypeScript examples
  verbatim; `onnxruntime-node`'s `InferenceSession`/`Tensor` shapes are standard-usage
  assumptions. Both verified on the Spark build, not here.
