# Scoring model training (offline, optional)

This is the *only* Python in `@mstack/adapters-scoring` (and one of two places Python
appears in the whole repo -- see research/06-architecture.md §2/§7 Wave-5 sidecar). It
trains an ICP-fit classifier offline from labeled account/conversion history and exports
it to ONNX, so `OnnxScorer` can run inference in-process, in TypeScript, with **no
Python at inference time**.

Until you run this, `train/model.onnx` does not exist and `OnnxScorer.available` is
`false` -- the stack degrades to `RulesScorer` (+`ClaudeScorer` if you've wired one in),
exactly per research/tools/D-warehouse-scoring.md: "OnnxScorer... opt-in once labeled
conversions exist."

## When to run this

Once you have labeled conversions in `@mstack/memory` -- accounts with a known
won/lost (or qualified/disqualified) outcome. Before that, there is no label to train
against; keep using Rules/Claude.

## Setup

```bash
cd packages/adapters-scoring/train
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

## Usage

```bash
python train.py --input accounts.csv --output model.onnx
python train.py --input accounts.csv --output model.onnx --model gradient_boosting
```

`accounts.csv` columns must match the feature order `OnnxScorer.featurize()` produces
(see `../src/onnx-scorer.ts` `FEATURE_NAMES`) plus a `label` column (1 = converted/good
fit, 0 = did not convert):

| employees_log10 | tech_count | signal_count | distinct_signal_kinds | recent_activity | label |
|---|---|---|---|---|---|

`train.py` is a skeleton: it trains `LogisticRegression` first (the interpretable
baseline recommended by research/tools/D-warehouse-scoring.md), reports a held-out
accuracy/AUC, and offers a `--model gradient_boosting` flag to escalate to
`GradientBoostingClassifier` once the dataset is rich enough. It writes `model.onnx` to
this directory (`OnnxScorer`'s default `modelPath`).

## The TS/ONNX contract (read before changing either side)

- Input tensor name: `"input"`, dtype `float32`, shape `[1, 5]` (one row at a time).
- Output: a `"probabilities"` tensor, shape `[1, 2]` = `[P(class 0), P(class 1)]`.
  `train.py` passes `options={id(model): {"zipmap": False}}` to `skl2onnx.to_onnx()`
  specifically so this is a plain tensor, not skl2onnx's default ZipMap (map-type)
  output -- ZipMap is awkward to consume from `onnxruntime-node`.
- Feature order is load-bearing and MUST match `OnnxScorer.featurize()` exactly:
  `employees_log10, tech_count, signal_count, distinct_signal_kinds, recent_activity`.
  If you add/reorder a feature on either side, update both.

## Known limitation

This skeleton has not been run against a real labeled dataset (none exists yet -- this
is the Wave-5 opt-in path). The TS/ONNX output-name assumptions above are standard
skl2onnx behavior but are unverified against an actual exported graph; `OnnxScorer`
falls back to positional output access if `"probabilities"` isn't found by name, as a
defensive second line. Verify both sides together the first time you actually train and
load a real model.
