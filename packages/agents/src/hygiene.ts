/**
 * Prompt hygiene — a lightweight advisory linter for agent `system` prompts.
 *
 * Harness policy (research/06-architecture.md §3.0): system prompts are
 * job-as-function ("You produce X"), never identity inflation ("You are an
 * elite Y"), and carry no panic/urgency framing. This measurably matters — the
 * emotion-vector work shows identity/panic framings causally raise misaligned
 * output, and a compliance reviewer is exactly where the calm baseline pays off.
 *
 * Advisory only: returns warnings, never throws. Wire it into a dev-time check,
 * or read it as executable documentation of the rule.
 */
const IDENTITY_INFLATION =
  /\b(elite|world[- ]?class|genius|superpower|ninja|rockstar|guru|10x)\b/i;
const PANIC = /\b(CRITICAL|URGENT|IMMEDIATELY|NEVER EVER|OR ELSE|MUST NOT FAIL)\b/;

export interface PromptHygieneWarning {
  rule: "identity-inflation" | "panic-framing";
  detail: string;
}

/** Return advisory warnings for a system prompt (empty array = clean). */
export function checkPromptHygiene(system: string): PromptHygieneWarning[] {
  const warnings: PromptHygieneWarning[] = [];
  const id = IDENTITY_INFLATION.exec(system);
  if (id) {
    warnings.push({
      rule: "identity-inflation",
      detail: `Identity inflation ("${id[0]}"). Describe the job-as-function ("You produce X"), not who the agent is.`,
    });
  }
  const panic = PANIC.exec(system);
  if (panic) {
    warnings.push({
      rule: "panic-framing",
      detail: `Panic/urgency framing ("${panic[0]}"). Prefer calm, plain directives — they lower misaligned output.`,
    });
  }
  return warnings;
}
