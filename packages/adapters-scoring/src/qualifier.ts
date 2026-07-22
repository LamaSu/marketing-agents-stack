/**
 * GaussianProcessQualifier -- an OFFLINE active-learning lead qualifier: an exact
 * Gaussian-Process regressor over account "profile embeddings" + BALD (Bayesian Active
 * Learning by Disagreement) uncertainty sampling. See
 * research/10-sota-integration-design.md §2.3 (OpenOutreach qualifier) and §5 Wave D row
 * D1.
 *
 * CLEAN-ROOM: the concept comes from OpenOutreach (GPLv3) -- studied for BEHAVIOR only,
 * no code copied. This is an independent implementation from the described idea.
 *
 * THE EDGE (why this fits us better than it fit its source): BALD selects the
 * HIGHEST-UNCERTAINTY accounts to route into the HUMAN APPROVAL QUEUE, and the human
 * approve/reject decisions ARE the training labels. The HITL gate and the active learner
 * become one loop -- every approval teaches the qualifier, offline. `selectForReview`
 * is the BALD acquisition step; `fit` consumes the labels that come back.
 *
 * OFFLINE-FIRST + ADDITIVE:
 *  - No network at construction or inference. Pure TS, deterministic. Account counts here
 *    are small, so an EXACT GP (RBF kernel, Cholesky solve of (K+σ²I)α=y) is tractable and
 *    needs no Python at inference. (An optional sklearn train sidecar exists at
 *    train/qualifier.py for scale; the TS exact-GP here is the primary path.)
 *  - This scorer is exported ADDITIVELY. It is NOT wired into the default `HybridScorer`
 *    blend -- `new HybridScorer()` is unchanged and still keyless/offline, and the Rules
 *    hard-disqualifier floor is untouched. Callers opt in explicitly.
 *  - COLD-START (zero/few labels) is the offline default: unfitted, the GP posterior IS
 *    the prior -> mean = `priorMean` (0.5) and variance = `signalVariance` uniformly, i.e.
 *    everything is maximally uncertain and every account routes to human review. That is
 *    exactly correct cold-start behavior and needs no data.
 *
 * THE "EMBEDDING": we reuse `featurize(account, signals)` from ./onnx-scorer.ts -- the same
 * fixed-length numeric vector the ONNX path learns on. The GP operates over these vectors,
 * standardized per-feature by the training set's mean/std (features live on very different
 * scales, so a single RBF length scale needs them standardized to be meaningful).
 */
import { featurize } from "./onnx-scorer.js";
import { tierForScore, clampScore } from "./tiers.js";
import type { ScoringProvider, ScoreResult, Account, Signal, ApprovalDecision } from "@mstack/core";

/** One supervised example for {@link GaussianProcessQualifier.fit}. `label` is the human
 *  decision as a number: 1 = approve/qualified, 0 = reject/disqualified (see
 *  {@link approvalToLabel}). A caller pulls persisted `Approval`s from `@mstack/memory`,
 *  joins each to its account + signals, and maps the decision to a label -- this package
 *  stays dependency-free by taking the labels as an argument rather than importing memory. */
export interface LabeledExample {
  account: Account;
  signals: Signal[];
  /** 1 = qualified/approve, 0 = disqualified/reject. Continuous values in [0,1] also work. */
  label: number;
}

/** An account (with its own signals) to evaluate. `featurize` needs each account's OWN
 *  signals, so candidates are (account, signals) pairs rather than one shared signal list. */
export interface QualifierCandidate {
  account: Account;
  signals: Signal[];
}

/** GP posterior at one point, in label space. */
export interface GpPosterior {
  /** posterior mean ~ qualification probability (nominally 0-1; not hard-clamped here). */
  mean: number;
  /** epistemic (latent-function) variance -- the BALD uncertainty proxy. In [0, signalVariance]. */
  variance: number;
  /** sqrt(variance). */
  std: number;
}

/** A candidate ranked for the review queue by BALD. */
export interface ReviewCandidate extends QualifierCandidate {
  posterior: GpPosterior;
  /** BALD information gain = 0.5·ln(1 + variance/noise). Monotone in variance, so this is
   *  the sort key; ranking by it == ranking by predictive variance. */
  informationGain: number;
}

export interface GaussianProcessQualifierConfig {
  /** RBF length scale over STANDARDIZED features. Larger = smoother. Default 1. */
  lengthScale?: number;
  /** Prior / marginal variance k(x,x); also the cold-start (unfitted) variance. Default 1. */
  signalVariance?: number;
  /** Observation noise σ². Keeps (K+σ²I) positive-definite and models label noise. Default 0.1. */
  noiseVariance?: number;
  /** GP prior mean = the qualification score with no evidence. Default 0.5 (neutral). */
  priorMean?: number;
  /** Override the featurizer (tests / alternate embeddings). Default: onnx-scorer `featurize`. */
  featurize?: (account: Account, signals: Signal[]) => number[];
}

/* ───────────────────────── linear-algebra helpers (module-private, pure) ───────────── */

/** Replace any non-finite feature with 0 so kernel math can never see NaN/Infinity. */
function sanitize(v: number[]): number[] {
  return v.map((x) => (Number.isFinite(x) ? x : 0));
}

/** z-score a vector by per-feature mean/std (std already guaranteed non-zero by the caller). */
function standardize(v: number[], mean: number[], std: number[]): number[] {
  return v.map((x, i) => (x - (mean[i] ?? 0)) / (std[i] || 1));
}

/** RBF (squared-exponential) kernel: signalVariance·exp(-||a-b||² / (2·lengthScale²)). */
function rbf(a: number[], b: number[], lengthScale: number, signalVariance: number): number {
  let sq = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sq += d * d;
  }
  return signalVariance * Math.exp(-sq / (2 * lengthScale * lengthScale));
}

/** Cholesky: A (n×n symmetric positive-definite) -> lower-triangular L with A = L·Lᵀ.
 *  (K+σ²I) is SPD because σ²>0; a tiny floor guards float round-off on the diagonal. */
function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const Ai = A[i] ?? [];
    const Li = L[i] ?? [];
    for (let j = 0; j <= i; j++) {
      const Lj = L[j] ?? [];
      let sum = Ai[j] ?? 0;
      for (let k = 0; k < j; k++) sum -= (Li[k] ?? 0) * (Lj[k] ?? 0);
      if (i === j) {
        Li[j] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        Li[j] = sum / ((Lj[j] ?? 0) || 1e-12);
      }
    }
  }
  return L;
}

/** Solve L·y = b for lower-triangular L (forward substitution). */
function forwardSub(L: number[][], b: number[]): number[] {
  const n = b.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const Li = L[i] ?? [];
    let sum = b[i] ?? 0;
    for (let k = 0; k < i; k++) sum -= (Li[k] ?? 0) * (y[k] ?? 0);
    y[i] = sum / ((Li[i] ?? 0) || 1e-12);
  }
  return y;
}

/** Solve Lᵀ·x = y for lower-triangular L (back substitution; Lᵀ[i][k] = L[k][i]). */
function backSubTranspose(L: number[][], y: number[]): number[] {
  const n = y.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i] ?? 0;
    for (let k = i + 1; k < n; k++) sum -= (L[k]?.[i] ?? 0) * (x[k] ?? 0);
    x[i] = sum / ((L[i]?.[i] ?? 0) || 1e-12);
  }
  return x;
}

/* ─────────────────────────────── the qualifier ────────────────────────────────────── */

export class GaussianProcessQualifier implements ScoringProvider {
  readonly name = "gp-qualifier";

  readonly #lengthScale: number;
  readonly #signalVariance: number;
  readonly #noiseVariance: number;
  readonly #priorMean: number;
  readonly #featurize: (account: Account, signals: Signal[]) => number[];

  // Fitted state (all undefined until fit() runs on >=1 example -> cold-start prior).
  #trainX: number[][] | undefined; // standardized training features
  #alpha: number[] | undefined; // (K+σ²I)⁻¹ (y − priorMean)
  #chol: number[][] | undefined; // Cholesky factor L of (K+σ²I)
  #featMean: number[] | undefined; // per-feature standardization mean
  #featStd: number[] | undefined; // per-feature standardization std (0 -> 1)

  constructor(config: GaussianProcessQualifierConfig = {}) {
    this.#lengthScale = config.lengthScale ?? 1;
    this.#signalVariance = config.signalVariance ?? 1;
    this.#noiseVariance = config.noiseVariance ?? 0.1;
    this.#priorMean = config.priorMean ?? 0.5;
    this.#featurize = config.featurize ?? featurize;
  }

  /** True once at least one label has been fitted. False = cold-start (uniform prior). */
  get fitted(): boolean {
    return this.#alpha !== undefined;
  }

  /**
   * Fit the exact GP on labeled examples (the human approvals). Recomputes from scratch
   * every call (small n) so re-fitting after each new approval is the intended usage.
   * Passing an empty array RESETS to the cold-start prior.
   */
  fit(examples: LabeledExample[]): this {
    if (examples.length === 0) {
      this.#trainX = undefined;
      this.#alpha = undefined;
      this.#chol = undefined;
      this.#featMean = undefined;
      this.#featStd = undefined;
      return this;
    }

    const raw = examples.map((e) => sanitize(this.#featurize(e.account, e.signals)));
    const d = raw[0]?.length ?? 0;
    const n = raw.length;

    // Per-feature mean + population std; a constant feature (std 0) becomes 1 (no scaling).
    const mean = new Array<number>(d).fill(0);
    for (const row of raw) for (let i = 0; i < d; i++) mean[i] = (mean[i] ?? 0) + (row[i] ?? 0) / n;
    const std = new Array<number>(d).fill(0);
    for (const row of raw) {
      for (let i = 0; i < d; i++) {
        const dv = (row[i] ?? 0) - (mean[i] ?? 0);
        std[i] = (std[i] ?? 0) + (dv * dv) / n;
      }
    }
    for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] ?? 0) || 1;

    const X = raw.map((row) => standardize(row, mean, std));

    // A = K + σ²I
    const A: number[][] = [];
    for (let i = 0; i < n; i++) {
      const xi = X[i] ?? [];
      const arow = new Array<number>(n).fill(0);
      for (let j = 0; j < n; j++) arow[j] = rbf(xi, X[j] ?? [], this.#lengthScale, this.#signalVariance);
      arow[i] = (arow[i] ?? 0) + this.#noiseVariance;
      A.push(arow);
    }

    // Solve (K+σ²I) α = (y − priorMean) via Cholesky: L z = yc, then Lᵀ α = z.
    const L = cholesky(A);
    const yc = examples.map((e) => e.label - this.#priorMean);
    const alpha = backSubTranspose(L, forwardSub(L, yc));

    this.#trainX = X;
    this.#chol = L;
    this.#alpha = alpha;
    this.#featMean = mean;
    this.#featStd = std;
    return this;
  }

  /** GP posterior (mean + epistemic variance) for one account. Cold-start = prior. */
  posteriorFor(account: Account, signals: Signal[]): GpPosterior {
    const alpha = this.#alpha;
    const L = this.#chol;
    const X = this.#trainX;
    const mean = this.#featMean;
    const std = this.#featStd;
    if (!alpha || !L || !X || !mean || !std) {
      // Unfitted -> posterior is the prior, identical for every input (uniform uncertainty).
      return { mean: this.#priorMean, variance: this.#signalVariance, std: Math.sqrt(this.#signalVariance) };
    }

    const xq = standardize(sanitize(this.#featurize(account, signals)), mean, std);
    const kstar = X.map((xi) => rbf(xq, xi, this.#lengthScale, this.#signalVariance));

    let m = this.#priorMean;
    for (let i = 0; i < kstar.length; i++) m += (kstar[i] ?? 0) * (alpha[i] ?? 0);

    // var = k(x*,x*) − v·v where L v = k*  (epistemic variance; excludes σ², the BALD proxy).
    const v = forwardSub(L, kstar);
    let vv = 0;
    for (const vi of v) vv += vi * vi;
    const variance = Math.max(0, this.#signalVariance - vv);

    return { mean: m, variance, std: Math.sqrt(variance) };
  }

  /** ScoringProvider surface: posterior mean -> 0-100 qualification score + tier, with the
   *  uncertainty surfaced in the rationale so a caller can see WHY it may want a human. */
  async score(account: Account, signals: Signal[]): Promise<ScoreResult> {
    const post = this.posteriorFor(account, signals);
    const score = clampScore(post.mean * 100);
    const tier = tierForScore(score);
    const ig = this.#informationGain(post.variance);
    const coldStart = this.fitted ? "" : " [cold-start prior: unfitted -> route to human review]";
    return {
      score,
      tier,
      rationale:
        `gp-qualifier posterior mean=${post.mean.toFixed(3)} (=> ${score}/100), ` +
        `uncertainty std=${post.std.toFixed(3)}, BALD info-gain=${ig.toFixed(3)}${coldStart}.`,
    };
  }

  /**
   * BALD acquisition: rank candidates by information gain (== predictive variance) and
   * return the top-k MOST UNCERTAIN accounts to push into the human approval queue. Their
   * approvals come back as labels for {@link fit}, closing the active-learning loop.
   * A negative `k` returns all candidates ranked (uncertain first).
   */
  selectForReview(candidates: QualifierCandidate[], k: number): ReviewCandidate[] {
    const ranked: ReviewCandidate[] = candidates.map((c) => {
      const posterior = this.posteriorFor(c.account, c.signals);
      return { account: c.account, signals: c.signals, posterior, informationGain: this.#informationGain(posterior.variance) };
    });
    ranked.sort((a, b) => b.informationGain - a.informationGain);
    return k >= 0 ? ranked.slice(0, k) : ranked;
  }

  /** BALD information gain for a GP-regression observation: 0.5·ln(1 + var/σ²). */
  #informationGain(variance: number): number {
    return 0.5 * Math.log(1 + variance / (this.#noiseVariance || 1e-9));
  }
}

/**
 * Map an `Approval` decision to a training label for {@link GaussianProcessQualifier.fit}.
 * approve -> 1, reject -> 0, edit -> null (ambiguous supervision, excluded from the label
 * set). Keeps the label-loop contract explicit without importing `@mstack/memory` here.
 */
export function approvalToLabel(decision: ApprovalDecision): number | null {
  if (decision === "approve") return 1;
  if (decision === "reject") return 0;
  return null;
}
