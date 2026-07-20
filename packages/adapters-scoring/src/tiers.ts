/**
 * Shared 0-100 -> AccountTier mapping used by every scorer (Rules/Onnx directly; Hybrid
 * applies it once more to the blended score). One place, one set of thresholds, so
 * "STRONG_FIT" means the same thing regardless of which provider produced the number.
 */
import type { AccountTier } from "@mstack/core";

export interface TierThresholds {
  /** score >= strongFit -> STRONG_FIT */
  strongFit: number;
  /** score >= fit -> FIT */
  fit: number;
  /** score >= partialFit -> PARTIAL_FIT; below -> DISQUALIFIED */
  partialFit: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  strongFit: 75,
  fit: 50,
  partialFit: 25,
};

/**
 * Map a 0-100 score to an AccountTier. Below `partialFit` is DISQUALIFIED -- this is how
 * a plain low score (as opposed to a RulesScorer hard disqualifier) still lands on the
 * same enum value; see rules-scorer.ts's header comment for the distinction between the
 * two paths to DISQUALIFIED.
 */
export function tierForScore(score: number, thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS): AccountTier {
  if (score >= thresholds.strongFit) return "STRONG_FIT";
  if (score >= thresholds.fit) return "FIT";
  if (score >= thresholds.partialFit) return "PARTIAL_FIT";
  return "DISQUALIFIED";
}

/** Round and clamp to the valid ScoreResult range (never NaN/Infinity, never out of 0-100). */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}
