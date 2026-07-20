/**
 * OnnxScorer -- optional ML scorer. Loads a model trained offline by `train/train.py`
 * (scikit-learn -> skl2onnx) and runs inference in-process via `onnxruntime-node`. See
 * research/tools/D-warehouse-scoring.md ("scikit-learn -> ONNX -> TS runtime (no Python
 * at inference)") and research/06-architecture.md §7 Wave-5 sidecar.
 *
 * NEVER THROWS AT IMPORT OR CONSTRUCTION. If no model file exists at `modelPath` (the
 * default, until someone runs `train/train.py` against real labeled data), `available`
 * stays `false` and `.score()` rejects with a clear, catchable error -- HybridScorer
 * treats that as "no ONNX contribution" and degrades to Rules (+Claude if injected),
 * never a crash. This is why `onnxruntime-node` is imported dynamically (`await
 * import("onnxruntime-node")`), gated behind a plain file-existence check, rather than
 * imported statically at module load -- a missing model or a broken native binary must
 * not break every other scorer or this package's own import.
 *
 * ASSUMPTIONS ABOUT `onnxruntime-node` + `train/train.py`'s exported ONNX graph (NOT
 * verified against a live run -- no labeled dataset ships with this repo, so no model
 * has ever actually been trained or loaded; verify together the first time one is, per
 * docs/build-conventions.md's "verify on the Spark build" convention):
 *   - `InferenceSession.create(path)` loads a `.onnx` file; `session.run(feeds)` takes a
 *     `Record<string, Tensor>` keyed by input name and resolves a `Record<string,
 *     Tensor>` keyed by output name -- standard onnxruntime-node usage.
 *   - The input tensor is named `"input"`, dtype float32, shape `[1, N_FEATURES]`.
 *     `train/train.py` sets this explicitly via skl2onnx's `initial_types` so the two
 *     sides of this seam do not depend on skl2onnx's naming defaults (see
 *     `train/README.md` "The TS/ONNX contract").
 *   - The graph exposes a `"probabilities"` output (skl2onnx's default second output for
 *     a classifier, forced to a plain tensor via `options={"zipmap": False}` in
 *     train.py, rather than the harder-to-consume ZipMap/map-type default). Shape
 *     `[1, 2]` for a binary classifier: `[P(not-fit), P(fit)]`. If a real trained graph
 *     names this differently, `#extractPositiveProbability` falls back to positional
 *     access over `session.run()`'s output map as a second line of defense.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tierForScore, clampScore } from "./tiers.js";
import type { ScoringProvider, ScoreResult, Account, Signal } from "@mstack/core";

export const FEATURE_NAMES = [
  "employees_log10",
  "tech_count",
  "signal_count",
  "distinct_signal_kinds",
  "recent_activity",
] as const;

/** Mirrors RulesScorer's feature set numerically, for train.py to learn on. Order is
 *  load-bearing -- see train/README.md "The TS/ONNX contract". */
export function featurize(account: Account, signals: Signal[]): number[] {
  const { employees, tech } = account.firmographic;
  const employeesLog = employees !== null && employees !== undefined && employees > 0 ? Math.log10(employees) : 0;
  const newestTs = signals.reduce((max, s) => (s.ts > max ? s.ts : max), "");
  const ageDays = newestTs ? (Date.now() - new Date(newestTs).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
  return [employeesLog, tech.length, signals.length, new Set(signals.map((s) => s.kind)).size, ageDays <= 14 ? 1 : 0];
}

/** Minimal slice of onnxruntime-node's surface this scorer needs, typed by hand so a
 *  missing/broken native binary only ever affects the one dynamic `import()` call site. */
interface OnnxTensorLike {
  data: Float32Array | number[] | BigInt64Array;
}
interface OnnxSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike>>;
}
interface OnnxRuntimeModule {
  InferenceSession: { create(path: string): Promise<OnnxSessionLike> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

export interface OnnxScorerOptions {
  /** Path to the trained `.onnx` file. Default: `<this package>/train/model.onnx`. */
  modelPath?: string;
  /** Inject a pre-loaded session directly (tests; also lets callers share one session
   *  across several OnnxScorer instances instead of re-loading the file each time). */
  session?: OnnxSessionLike;
}

const HERE = dirname(fileURLToPath(import.meta.url)); // .../dist or .../src -- one level under the package root either way
const DEFAULT_MODEL_PATH = join(HERE, "..", "train", "model.onnx");

export class OnnxScorer implements ScoringProvider {
  readonly name = "onnx";
  readonly #modelPath: string;
  #session: OnnxSessionLike | undefined;
  #ort: OnnxRuntimeModule | undefined;
  #probedUnavailable = false;

  constructor(options: OnnxScorerOptions = {}) {
    this.#modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
    this.#session = options.session;
  }

  /** True once a session is loaded or injected. Does not itself trigger loading -- read
   *  it after a `.score()` call (or after an explicit probe) if you need to know before
   *  scoring whether ONNX will contribute. */
  get available(): boolean {
    return this.#session !== undefined;
  }

  async #ensureSession(): Promise<OnnxSessionLike | undefined> {
    if (this.#session) return this.#session;
    if (this.#probedUnavailable) return undefined;
    if (!existsSync(this.#modelPath)) {
      this.#probedUnavailable = true;
      return undefined;
    }
    try {
      const ort = (await import("onnxruntime-node")) as unknown as OnnxRuntimeModule;
      this.#ort = ort;
      this.#session = await ort.InferenceSession.create(this.#modelPath);
      return this.#session;
    } catch {
      this.#probedUnavailable = true;
      return undefined;
    }
  }

  async score(account: Account, signals: Signal[]): Promise<ScoreResult> {
    const session = await this.#ensureSession();
    if (!session || !this.#ort) {
      throw new Error(
        `OnnxScorer: no model at ${this.#modelPath} -- run train/train.py against labeled data to produce one. ` +
          `Optional: the stack degrades to Rules/Claude without it.`,
      );
    }

    const features = featurize(account, signals);
    const inputTensor = new this.#ort.Tensor("float32", Float32Array.from(features), [1, features.length]);
    const outputs = await session.run({ input: inputTensor });
    const positiveProb = this.#extractPositiveProbability(outputs);

    const score = clampScore(positiveProb * 100);
    const tier = tierForScore(score);
    return {
      score,
      tier,
      rationale: `onnx model P(fit)=${positiveProb.toFixed(3)} over [${FEATURE_NAMES.join(", ")}] -> ${score}/100.`,
    };
  }

  #extractPositiveProbability(outputs: Record<string, OnnxTensorLike>): number {
    const named = outputs["probabilities"];
    const values = Object.values(outputs);
    const tensor = named ?? values[1] ?? values[0];
    if (!tensor) throw new Error("OnnxScorer: model produced no usable output tensor");
    const data = tensor.data;
    const value = data.length >= 2 ? data[1] : data[0];
    return Math.max(0, Math.min(1, Number(value ?? 0)));
  }
}
