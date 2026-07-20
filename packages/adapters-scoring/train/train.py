"""Train an ICP-fit classifier offline and export it to ONNX for OnnxScorer.

Offline, train-time only -- see ../README.md. This is a skeleton (research/06-architecture.md
§7 Wave-5 sidecar: "Python packages/adapters-scoring/train/ ... the ONLY Python in the
repo, and it runs offline at train time, never at inference"). No labeled dataset ships
with this repo, so this script has not been run end-to-end; it documents the intended
shape and the TS/ONNX contract precisely (see README.md), so a user with real labeled
data can run it directly or lightly adapt it.

Usage:
    python train.py --input accounts.csv --output model.onnx
    python train.py --input accounts.csv --output model.onnx --model gradient_boosting
"""
from __future__ import annotations

import argparse

FEATURE_NAMES = [
    "employees_log10",
    "tech_count",
    "signal_count",
    "distinct_signal_kinds",
    "recent_activity",
]
LABEL_COLUMN = "label"


def load_dataset(path: str):
    import pandas as pd

    df = pd.read_csv(path)
    missing = [c for c in (*FEATURE_NAMES, LABEL_COLUMN) if c not in df.columns]
    if missing:
        raise ValueError(
            f"{path} is missing required column(s): {missing}. "
            f"Expected columns: {FEATURE_NAMES + [LABEL_COLUMN]} (see README.md)."
        )
    X = df[FEATURE_NAMES].to_numpy(dtype="float32")
    y = df[LABEL_COLUMN].to_numpy()
    return X, y


def train_model(X, y, kind: str):
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, roc_auc_score
    from sklearn.model_selection import train_test_split

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if len(set(y)) > 1 else None
    )

    model = (
        GradientBoostingClassifier(random_state=42)
        if kind == "gradient_boosting"
        else LogisticRegression(max_iter=1000)
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print(f"[train.py] {kind}: held-out accuracy = {accuracy_score(y_test, preds):.3f}")
    if len(set(y_test)) > 1:
        proba = model.predict_proba(X_test)[:, 1]
        print(f"[train.py] {kind}: held-out AUC = {roc_auc_score(y_test, proba):.3f}")

    return model


def export_onnx(model, output_path: str) -> None:
    from skl2onnx import to_onnx
    from skl2onnx.common.data_types import FloatTensorType

    # Input tensor named "input" so OnnxScorer's TS side has a fixed, documented name to
    # feed rather than depending on skl2onnx's naming defaults. zipmap=False makes the
    # classifier's second output ("probabilities") a plain tensor instead of the
    # ZipMap/map-type default -- see README.md "The TS/ONNX contract".
    onnx_model = to_onnx(
        model,
        initial_types=[("input", FloatTensorType([None, len(FEATURE_NAMES)]))],
        options={id(model): {"zipmap": False}},
    )
    with open(output_path, "wb") as f:
        f.write(onnx_model.SerializeToString())
    print(f"[train.py] wrote {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="CSV with feature columns + a label column (see README.md)")
    parser.add_argument("--output", default="model.onnx", help="Output .onnx path (default: model.onnx)")
    parser.add_argument(
        "--model",
        choices=["logistic_regression", "gradient_boosting"],
        default="logistic_regression",
        help="Start with logistic_regression (interpretable baseline); escalate once the dataset is rich enough.",
    )
    args = parser.parse_args()

    X, y = load_dataset(args.input)
    model = train_model(X, y, args.model)
    export_onnx(model, args.output)


if __name__ == "__main__":
    main()
