"""Fit a probability-CALIBRATED ICP-fit classifier and export it to ONNX for OnnxScorer.

Offline, train-time only -- see README.md "Calibration (calibrate.py)". This closes the
"Probability calibration" gap in research/10-sota-integration-design.md §2.6 point 1: a
raw classifier's `predict_proba` is not a calibrated probability -- a model that outputs
0.8 does not necessarily mean "80% of accounts like this one convert" -- so the A/B/C/D
tier bands built on top of it (see ../src/tiers.ts) are somewhat arbitrary. This is the
highest correctness-per-effort scoring win in that section.

`sklearn.calibration.CalibratedClassifierCV` fixes that by fitting a secondary map from
the base estimator's raw scores to well-calibrated probabilities, evaluated against a
held-out split it manages internally (`cv` folds: the base estimator is fit on cv-1
folds and calibrated against the held-out fold, repeated across folds, so calibration is
always evaluated on rows the base estimator did not train on). Two calibration methods:

  - `sigmoid` (Platt scaling) -- a 2-parameter logistic fit. Works with little data.
  - `isotonic` -- a nonparametric, more expressive step-function fit. More accurate with
    enough data, but overfits / degenerates on small datasets. See
    https://scikit-learn.org/stable/modules/calibration.html.

`choose_method()` below picks automatically by dataset size (override with --method).

Like train.py, no labeled dataset ships with this repo, so this script has not been run
end-to-end -- it documents the intended shape precisely and REUSES train.py's exact CSV
loading (`load_dataset`) and ONNX export (`export_onnx`) so a calibrated model is
guaranteed to land on the identical TS/ONNX contract OnnxScorer already expects (input
tensor "input", float32, shape [1,5]; output "probabilities", zipmap=False -- see
../src/onnx-scorer.ts and README.md's "The TS/ONNX contract"). A user with real labeled
data can run this directly.

This script is entirely separate from OnnxScorer's inference path
(packages/adapters-scoring/src/onnx-scorer.ts) -- it produces a `.onnx` file offline;
nothing here runs in the request/scoring hot path.

UNVERIFIED (flagging honestly, same as train.py's own docstring and README.md's "Known
limitation" -- no dataset exists yet to run this against): skl2onnx ships a converter for
`CalibratedClassifierCV` in recent releases, but that has not been exercised here against
the pinned `skl2onnx>=1.16` in requirements.txt. Verify together the first time you
actually run this against real data -- if the installed skl2onnx lacks the converter, the
error will surface directly from `to_onnx()` in `export_onnx()`.

Usage:
    python calibrate.py --input accounts.csv --output model.onnx
    python calibrate.py --input accounts.csv --output model.onnx --method isotonic
    python calibrate.py --input accounts.csv --output model.onnx --base gradient_boosting --cv 10
"""
from __future__ import annotations

import argparse

# Reuse train.py's CSV contract and ONNX export verbatim -- one source of truth for both
# the feature/label schema and the TS/ONNX tensor contract, so a calibrated model is
# provably compatible with OnnxScorer, not just documented as such. Both are cheap
# module-level imports: train.py's own heavy deps (pandas/sklearn/skl2onnx) are imported
# lazily INSIDE its functions, so `import train` here does not require them until the
# functions that need them are actually called (mirrored below for the same reason).
from train import FEATURE_NAMES, LABEL_COLUMN, load_dataset, export_onnx  # noqa: F401  (FEATURE_NAMES/LABEL_COLUMN re-exported for callers)

# Below this many labeled TRAINING rows, isotonic regression's step-function fit tends to
# overfit / degenerate (standard sklearn guidance: prefer Platt/sigmoid calibration on
# small data, isotonic once there is enough of it). Not a hard boundary -- a reasonable,
# documented default a real dataset can override with --method.
ISOTONIC_MIN_ROWS = 1000


def choose_method(n_training_rows: int) -> str:
    """Platt scaling ("sigmoid") below ISOTONIC_MIN_ROWS training rows, isotonic at/above it."""
    return "isotonic" if n_training_rows >= ISOTONIC_MIN_ROWS else "sigmoid"


def build_base_estimator(kind: str):
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression

    return GradientBoostingClassifier(random_state=42) if kind == "gradient_boosting" else LogisticRegression(max_iter=1000)


def fit_calibrated(X, y, base_kind: str, method: str | None, cv: int):
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import train_test_split

    # The outer 20% (X_test/y_test) is held out from calibration entirely and used ONLY
    # for the final calibration-quality report below -- CalibratedClassifierCV's own `cv`
    # folds (over X_train) are a separate, internal held-out split used to fit the
    # calibration map itself. Two distinct held-out splits for two distinct purposes.
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if len(set(y)) > 1 else None
    )

    resolved_method = method or choose_method(len(X_train))
    base = build_base_estimator(base_kind)

    # `base` is passed POSITIONALLY (not as a `base_estimator=`/`estimator=` keyword) --
    # sklearn renamed this constructor argument from `base_estimator` to `estimator`
    # across the 1.2-1.4 deprecation window (requirements.txt pins scikit-learn>=1.4,
    # where `estimator` is current), and positional passing is correct either way.
    calibrated = CalibratedClassifierCV(base, method=resolved_method, cv=cv)
    calibrated.fit(X_train, y_train)

    print(f"[calibrate.py] base={base_kind} method={resolved_method} cv={cv} train_rows={len(X_train)}")
    _report_calibration(calibrated, X_test, y_test)

    return calibrated


def _report_calibration(model, X_test, y_test) -> None:
    """Held-out calibration-quality report. Brier score is the standard scalar summary
    of calibration + discrimination together (mean squared error between the predicted
    probability and the 0/1 outcome; lower is better, 0 is perfect) -- the metric
    CalibratedClassifierCV is trying to improve versus the base estimator's raw,
    uncalibrated predict_proba. Comparing directly against the uncalibrated base
    estimator's Brier score on the same split is a natural next step for a real dataset,
    intentionally left to the caller rather than built in here."""
    from sklearn.metrics import brier_score_loss, roc_auc_score

    if len(X_test) == 0:
        print("[calibrate.py] no held-out rows -- skipping calibration-quality report")
        return

    proba = model.predict_proba(X_test)[:, 1]
    print(f"[calibrate.py] held-out Brier score = {brier_score_loss(y_test, proba):.4f}")
    if len(set(y_test)) > 1:
        print(f"[calibrate.py] held-out AUC = {roc_auc_score(y_test, proba):.3f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="CSV with feature columns + a label column (see ../README.md)")
    parser.add_argument("--output", default="model.onnx", help="Output .onnx path (default: model.onnx)")
    parser.add_argument(
        "--base",
        choices=["logistic_regression", "gradient_boosting"],
        default="logistic_regression",
        help="Base estimator to wrap in CalibratedClassifierCV (same choices as train.py's --model).",
    )
    parser.add_argument(
        "--method",
        choices=["isotonic", "sigmoid"],
        default=None,
        help="Calibration method. Default: auto -- sigmoid (Platt) below "
        f"{ISOTONIC_MIN_ROWS} training rows, isotonic at/above it (see choose_method()).",
    )
    parser.add_argument("--cv", type=int, default=5, help="Cross-validation folds for CalibratedClassifierCV (default: 5).")
    args = parser.parse_args()

    X, y = load_dataset(args.input)
    calibrated = fit_calibrated(X, y, args.base, args.method, args.cv)
    export_onnx(calibrated, args.output)


if __name__ == "__main__":
    main()
