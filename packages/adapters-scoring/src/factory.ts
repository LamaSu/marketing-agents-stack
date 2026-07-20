/**
 * scoringProvider(name?, config?) -- construct any ScoringProvider by name. The default
 * (`scoringProvider()`, no arguments) is a `HybridScorer` with no injected Claude client
 * and a default `OnnxScorer` -- i.e. it degrades cleanly to Rules-only, fully offline,
 * zero configuration. See research/06-architecture.md §5.1 ("Scoring | ScoringProvider |
 * RulesScorer (zero dep) | ClaudeScorer (Claude key) for cold-start rationale; OnnxScorer
 * once you have labeled conversions").
 */
import type { ScoringProvider } from "@mstack/core";
import { RulesScorer, type RulesScorerConfig } from "./rules-scorer.js";
import { ClaudeScorer, type ClaudeScorerOptions } from "./claude-scorer.js";
import { OnnxScorer, type OnnxScorerOptions } from "./onnx-scorer.js";
import { HybridScorer, type HybridScorerOptions } from "./hybrid-scorer.js";

export type ScorerName = "rules" | "claude" | "onnx" | "hybrid";

export interface ScorerConfigs {
  rules: RulesScorerConfig;
  claude: ClaudeScorerOptions;
  onnx: OnnxScorerOptions;
  hybrid: HybridScorerOptions;
}

export function scoringProvider(): HybridScorer;
export function scoringProvider<N extends ScorerName>(name: N, config?: ScorerConfigs[N]): ScoringProvider;
export function scoringProvider(name?: ScorerName, config?: unknown): ScoringProvider {
  switch (name ?? "hybrid") {
    case "rules":
      return new RulesScorer(config as RulesScorerConfig | undefined);
    case "claude":
      return new ClaudeScorer(config as ClaudeScorerOptions | undefined);
    case "onnx":
      return new OnnxScorer(config as OnnxScorerOptions | undefined);
    case "hybrid":
    default:
      return new HybridScorer(config as HybridScorerOptions | undefined);
  }
}
