/** Thin per-agent model router over @mstack/core's model map. */
import { modelFor, type AgentRole } from "@mstack/core";

export type { AgentRole };

/** Resolve the model id for an agent role (honors MODEL_* env overrides). */
export function modelRouter(role: AgentRole): string {
  return modelFor(role);
}
