/**
 * Central model-id map for the product agents. Verify ids live against the models
 * endpoint before shipping (harness policy on cached model catalogs).
 *
 * Routing rationale (from research/06-architecture.md §3.0):
 *  - reviewer judge  -> opus:   correctness on brand/legal-adjacent findings is worth the premium
 *  - reasoning/copy  -> sonnet: reasoning over signals + drafting copy
 *  - router/classify -> haiku:  cheap, high-volume classification and score assists
 */

export const DEFAULT_MODELS = {
  reviewerJudge: "claude-opus-4-8",
  reasoner: "claude-sonnet-5",
  copywriter: "claude-sonnet-5",
  guidelineAuthor: "claude-sonnet-5",
  router: "claude-haiku-4-5-20251001",
  classify: "claude-haiku-4-5-20251001",
  scoreAssist: "claude-haiku-4-5-20251001",
} as const;

export type AgentRole = keyof typeof DEFAULT_MODELS;

/** env overrides: MODEL_REVIEWER / MODEL_REASONER / MODEL_CLASSIFIER (see .env.example). */
const ENV_OVERRIDE: Partial<Record<AgentRole, string | undefined>> = {
  reviewerJudge: process.env.MODEL_REVIEWER,
  reasoner: process.env.MODEL_REASONER,
  copywriter: process.env.MODEL_REASONER,
  guidelineAuthor: process.env.MODEL_REASONER,
  router: process.env.MODEL_CLASSIFIER,
  classify: process.env.MODEL_CLASSIFIER,
  scoreAssist: process.env.MODEL_CLASSIFIER,
};

/** Resolve the model id for an agent role, honoring env overrides. */
export function modelFor(role: AgentRole): string {
  return ENV_OVERRIDE[role] ?? DEFAULT_MODELS[role];
}
