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

## Calibration (`calibrate.py`)

`train.py`'s raw `predict_proba` is not a calibrated probability -- a score of 0.8 does
not necessarily mean "80% of accounts like this one convert." `calibrate.py` fixes that
with `sklearn.calibration.CalibratedClassifierCV`, wrapping the same base estimator
choices (`--base logistic_regression|gradient_boosting`) and picking a calibration
method automatically by dataset size -- Platt/`sigmoid` below 1000 training rows
(2-parameter fit, works with little data), `isotonic` at/above it (more expressive,
needs more data to avoid overfitting). Override with `--method`.

```bash
python calibrate.py --input accounts.csv --output model.onnx
python calibrate.py --input accounts.csv --output model.onnx --method isotonic
python calibrate.py --input accounts.csv --output model.onnx --base gradient_boosting --cv 10
```

Same `accounts.csv` shape as `train.py` (see the columns table above) -- `calibrate.py`
imports `train.py`'s own `load_dataset`/`export_onnx` directly rather than duplicating
them, so both scripts are provably on the identical CSV contract and the identical
ONNX/TS contract described below. It reports the held-out Brier score (and AUC, when
both classes are present) so you can see the calibration quality before shipping
`model.onnx`.

**Unverified**, same caveat as `train.py` -- no labeled dataset ships with this repo, so
this has not been run end-to-end. skl2onnx is expected to have a `CalibratedClassifierCV`
converter in recent releases, but that has not been exercised against the pinned
`skl2onnx>=1.16`; verify together the first time you actually run this against real data.

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
