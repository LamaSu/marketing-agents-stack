/**
 * Autopilot eligibility -- research/06-architecture.md guardrail #2:
 * "Autopilot is an explicit, logged auto-approve *policy* scoped to
 * low-tier accounts -- never STRONG_FIT/VIP."
 *
 * This package never dispatches or auto-approves anything itself -- there is
 * no code path anywhere in this package that calls
 * `MemoryRepo.appendApproval`, and `activate-account.ts` never sets a
 * `Draft`'s status to anything but the schema's own `'pending'` default.
 * `mode:'autopilot'` only sets this eligibility *policy flag* (and is
 * carried through onto the persisted `Decision.mode` field); it is Wave-4
 * `runtime` -- out of this package's scope -- that would actually turn an
 * eligible decision into an auto-created `Approval`.
 *
 * "Low-tier" is deliberately narrow here: `PARTIAL_FIT` only. `STRONG_FIT`
 * is the architecture doc's explicitly named VIP exclusion; `FIT` is
 * excluded too, conservatively -- a mid-tier account is not "low-tier"
 * either. The exact policy table (which tiers, rate limits, kill-switch) is
 * explicitly scoped to `runtime` as deployer config (architecture doc
 * Appendix); this is this package's conservative default, not the final
 * word.
 */
import type { AccountTier, AgentMode } from "@mstack/core";

export function isAutopilotEligible(tier: AccountTier, mode: AgentMode): boolean {
  return mode === "autopilot" && tier === "PARTIAL_FIT";
}
