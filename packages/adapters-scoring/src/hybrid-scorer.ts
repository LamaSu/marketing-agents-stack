/**
 * HybridScorer -- the default composite ScoringProvider. Blend =
 * `max(rulesScore, weighted(onnxScore, claudeScore))`, taken directly from
 * research/tools/D-warehouse-scoring.md's "THE SCORING PROVIDER INTERFACE" section:
 * "rules provide a fast floor + hard disqualifiers; the ML model supplies a calibrated
 * probability when available; the LLM supplies the rationale and breaks ties / handles
 * sparse-signal accounts. Blend = max(rules_floor, weighted(ml, llm)) with the LLM
 * rationale always attached."
 *
 * Rules ALWAYS run (pure, offline, cannot fail). Claude runs ONLY if a `ClaudeScorer` is
 * injected via `options.claude` -- there is no default/implicit Claude client, so
 * `new HybridScorer()` with zero config never touches the network. Onnx runs via a
 * default `OnnxScorer` unless overridden; it contributes only if a trained model file is
 * actually present (see onnx-scorer.ts) -- so it is always safe to leave at its default.
 * Either optional scorer failing (Claude refusal/network error; no ONNX model) is caught
 * here and simply drops that scorer from the blend -- HybridScorer itself never throws
 * for a missing optional contributor.
 *
 * COMPLIANCE FLOOR: a Rules hard-disqualifier is unconditional. If `RulesScorer` returns
 * tier `DISQUALIFIED` (competitor, unsubscribed, do-not-contact, sparse-and-unqualified),
 * `score()` returns that result immediately and the Claude/Onnx blend is skipped entirely
 * -- an optimistic LLM/ML score can never rescue a disqualified account. The `max(rules,
 * weighted(ml,llm))` blend only applies to accounts that clear the rules gate.
 */
import { tierForScore } from "./tiers.js";
import { RulesScorer } from "./rules-scorer.js";
import { ClaudeScorer } from "./claude-scorer.js";
import { OnnxScorer } from "./onnx-scorer.js";
import type { ScoringProvider, ScoreResult, Account, Signal } from "@mstack/core";

export interface HybridScorerWeights {
  /** weight of the ONNX score inside `weighted(onnx, claude)`. Default 1.6 -- a
   *  calibrated model, once trained, outweighs an LLM's cold-start guess. */
  onnx?: number;
  /** weight of the Claude score inside `weighted(onnx, claude)`. Default 1. */
  claude?: number;
}

export interface HybridScorerOptions {
  /** Override the always-on Rules scorer's config/instance. Defaults to `new RulesScorer()`. */
  rules?: RulesScorer;
  /** Inject a ClaudeScorer to opt into cold-start LLM scoring. Omit to stay offline --
   *  this is the "if client" gate: HybridScorer never constructs a ClaudeScorer (and
   *  therefore never an Anthropic client) on its own. */
  claude?: ClaudeScorer;
  /** Override the ONNX scorer's config/instance. Defaults to `new OnnxScorer()`, which
   *  self-disables gracefully if no trained model file is present -- safe to leave at
   *  its default even before you have one. */
  onnx?: OnnxScorer;
  weights?: HybridScorerWeights;
}

const DEFAULT_WEIGHTS: Required<HybridScorerWeights> = { onnx: 1.6, claude: 1 };

export class HybridScorer implements ScoringProvider {
  readonly name = "hybrid";
  readonly #rules: RulesScorer;
  readonly #claude: ClaudeScorer | undefined;
  readonly #onnx: OnnxScorer;
  readonly #weights: Required<HybridScorerWeights>;

  constructor(options: HybridScorerOptions = {}) {
    this.#rules = options.rules ?? new RulesScorer();
    this.#claude = options.claude;
    this.#onnx = options.onnx ?? new OnnxScorer();
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  }

  async score(account: Account, signals: Signal[]): Promise<ScoreResult> {
    const rulesResult = await this.#rules.score(account, signals);

    // Hard floor: a Rules hard-disqualifier (competitor, unsubscribed, do-not-contact) is
    // unconditional -- an optimistic ML/LLM score must never rescue a disqualified account.
    // Rules own the compliance gate; the blend only applies to non-disqualified accounts.
    if (rulesResult.tier === "DISQUALIFIED") {
      const detail = rulesResult.rationale ? ` | ${rulesResult.rationale}` : "";
      return { score: rulesResult.score, tier: "DISQUALIFIED", rationale: `hybrid(rules) | disqualified by rules (hard floor)${detail}` };
    }

    const contributors: Array<{ source: "claude" | "onnx"; score: number; weight: number }> = [];

    if (this.#claude) {
      try {
        const claudeResult = await this.#claude.score(account, signals);
        contributors.push({ source: "claude", score: claudeResult.score, weight: this.#weights.claude });
      } catch {
        // Refusal / network / auth failure -- drop Claude from this call's blend, don't fail the score.
      }
    }

    try {
      const onnxResult = await this.#onnx.score(account, signals);
      contributors.push({ source: "onnx", score: onnxResult.score, weight: this.#weights.onnx });
    } catch {
      // No trained model yet -- the expected default state (Wave-5 sidecar is opt-in).
    }

    const weightSum = contributors.reduce((sum, c) => sum + c.weight, 0);
    const mlLlmScore = weightSum > 0 ? contributors.reduce((sum, c) => sum + c.score * c.weight, 0) / weightSum : undefined;

    const finalScore = mlLlmScore === undefined ? rulesResult.score : Math.round(Math.max(rulesResult.score, mlLlmScore));
    const tier = tierForScore(finalScore);

    const parts = [
      `hybrid(${["rules", ...contributors.map((c) => c.source)].join("+")})`,
      `rules=${rulesResult.score}`,
      ...contributors.map((c) => `${c.source}=${Math.round(c.score)}`),
    ];
    if (rulesResult.rationale) parts.push(`rules detail: ${rulesResult.rationale}`);

    return { score: finalScore, tier, rationale: parts.join(" | ") };
  }
}
