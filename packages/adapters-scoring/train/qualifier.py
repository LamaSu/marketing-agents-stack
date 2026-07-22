"""OPTIONAL train-time sidecar for the GP+BALD qualifier (../src/qualifier.ts).

Offline, train-time only, and OPTIONAL: the TypeScript exact-GP in ../src/qualifier.ts is
the PRIMARY inference path and runs with sensible default hyperparameters and NO Python.
This sidecar exists only for SCALE -- when you have enough labeled approvals that tuned
kernel hyperparameters (fit by maximizing the marginal likelihood) beat the TS defaults.

It fits a scikit-learn `GaussianProcessRegressor` over the SAME account embedding the TS
side uses (the `featurize()` feature columns) with an isotropic RBF kernel, then exports
the OPTIMIZED hyperparameters as a small portable JSON. Those fields map one-to-one onto
`GaussianProcessQualifierConfig` in TS -- the caller just constructs
`new GaussianProcessQualifier(json)` and fits on its approval labels as usual. So Python
tunes the kernel; TS stays the inference authority (it already holds the labels at
runtime). Unlike train.py/calibrate.py, this exports hyperparameter JSON, NOT an ONNX
graph -- an exact GP posterior is cheap to recompute in TS from (labels + hyperparameters),
and re-fitting after every new approval is the intended usage.

Consistency with the TS side (../src/qualifier.ts), so the exported hyperparameters mean
the same thing there:
  - Features are STANDARDIZED (per-feature mean/std) before the kernel, exactly as TS does
    at fit time -- so the single exported `lengthScale` lives in the same standardized space.
  - Targets are CENTERED by the label mean (exported as `priorMean`); we fit on (y - mean)
    with normalize_y=False, matching TS which centers by priorMean and never rescales y.
  - ConstantKernel -> `signalVariance`, RBF length_scale -> `lengthScale`, WhiteKernel
    noise_level -> `noiseVariance`. TS's (K + noiseVariance*I) Cholesky solve then reproduces
    the same posterior mean/variance this GPR would give.

Like train.py/calibrate.py, no labeled dataset ships with this repo, so this has NOT been
run end-to-end; it documents the intended shape precisely and reuses train.py's CSV
loader so it is provably on the identical CSV contract. Verify against real data the first
time you run it.

Usage:
    python qualifier.py --input accounts.csv --output qualifier-hparams.json
    python qualifier.py --input accounts.csv --output qualifier-hparams.json --restarts 10
"""
from __future__ import annotations

import argparse
import json

# Reuse train.py's exact CSV contract (5 feature columns + a `label` column). Keeping a
# single loader guarantees this sidecar and OnnxScorer's train path agree on column order.
from train import FEATURE_NAMES, LABEL_COLUMN, load_dataset


def fit_hyperparameters(X, y, restarts: int) -> dict:
    import numpy as np
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import RBF, ConstantKernel, WhiteKernel
    from sklearn.preprocessing import StandardScaler

    # Standardize features (matches TS fit-time standardization) so the length scale is
    # comparable to the TS side's single-length-scale-over-standardized-features model.
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)

    # Center targets by their mean; fit on the residual (matches TS priorMean centering).
    prior_mean = float(np.mean(y))
    yc = y.astype("float64") - prior_mean

    # ConstantKernel -> signalVariance, RBF -> lengthScale, WhiteKernel -> noiseVariance.
    kernel = ConstantKernel(1.0, (1e-3, 1e3)) * RBF(1.0, (1e-2, 1e2)) + WhiteKernel(0.1, (1e-5, 1e1))
    gpr = GaussianProcessRegressor(kernel=kernel, normalize_y=False, n_restarts_optimizer=restarts, random_state=42)
    gpr.fit(Xs, yc)

    fitted = gpr.kernel_
    # fitted = (ConstantKernel * RBF) + WhiteKernel  ->  fitted.k1 = product, fitted.k2 = white
    signal_variance = float(fitted.k1.k1.constant_value)
    length_scale = fitted.k1.k2.length_scale
    length_scale = float(np.mean(length_scale)) if hasattr(length_scale, "__len__") else float(length_scale)
    noise_variance = float(fitted.k2.noise_level)

    print(f"[qualifier.py] log-marginal-likelihood = {gpr.log_marginal_likelihood_value_:.4f}")
    print(f"[qualifier.py] lengthScale={length_scale:.4f} signalVariance={signal_variance:.4f} noiseVariance={noise_variance:.4f} priorMean={prior_mean:.4f}")

    return {
        "kind": "gp-qualifier-hparams",
        "featureNames": FEATURE_NAMES,
        "standardize": True,
        "lengthScale": length_scale,
        "signalVariance": signal_variance,
        "noiseVariance": noise_variance,
        "priorMean": prior_mean,
        "note": (
            "Optional tuned hyperparameters for ../src/qualifier.ts GaussianProcessQualifier. "
            "Construct new GaussianProcessQualifier({lengthScale, signalVariance, noiseVariance, "
            "priorMean}) and fit() on your approval labels. The TS exact-GP is the primary path; "
            "these fields simply replace its defaults."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help=f"CSV with columns {FEATURE_NAMES + [LABEL_COLUMN]} (see README.md)")
    parser.add_argument("--output", default="qualifier-hparams.json", help="Output JSON path (default: qualifier-hparams.json)")
    parser.add_argument("--restarts", type=int, default=5, help="n_restarts_optimizer for marginal-likelihood optimization (default: 5)")
    args = parser.parse_args()

    X, y = load_dataset(args.input)
    hparams = fit_hyperparameters(X, y, args.restarts)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(hparams, f, indent=2)
    print(f"[qualifier.py] wrote {args.output}")


if __name__ == "__main__":
    main()
