/**
 * SDR-Researcher -- the first swarm worker (research/06-architecture.md §3.2
 * table + system-prompt sketch). Surfaces the signals relevant to ONE
 * account and says why each matters now; resolves the likely buying
 * committee. Tight scope: no outreach, no scoring, no sending.
 *
 * Bound to the persisted signal rows: the system prompt requires every
 * `signalId` in the output to be one that actually appears in
 * `input.signals` -- the direct fix (per the architecture doc) for "my AI is
 * lying to me because it didn't have the context." Conflicting signals are
 * surfaced in `why`, never silently averaged (guardrail #6 -- "conflict is
 * the finding").
 *
 * Evidence is passed via `input` (plain JSON), not a `contextPack` -- see
 * the package README's "Known assumptions" section for why.
 */
import { z } from "zod";
import { RelevantSignal, CommitteeMember, modelFor } from "@mstack/core";
import type { Signal, EnrichmentRecord } from "@mstack/core";
import { runAgent } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

export const SdrResearcherOutput = z.object({
  relevantSignals: z.array(RelevantSignal),
  buyingCommittee: z.array(CommitteeMember),
});
export type SdrResearcherOutput = z.infer<typeof SdrResearcherOutput>;

export interface SdrResearcherInput {
  account: { domain: string; name: string };
  /** every signal this worker is permitted to cite -- the output's
   *  `relevantSignals[].signalId` values must all be drawn from here. */
  signals: Signal[];
  enrichment: EnrichmentRecord | null;
}

export const SDR_RESEARCHER_SYSTEM_PROMPT =
  "You produce an account signal brief. Given one account's raw signals and " +
  "enrichment record, output the subset of signals that matter for a sales " +
  "conversation and, for each, one sentence on why it matters now. Also " +
  "resolve the likely buying committee (name, role, persona, and influence " +
  "when it's evident from the input). You do not write outreach and you do " +
  "not send anything -- that is a separate step. Cite only `signalId` " +
  "values that actually appear in the input `signals` array -- never invent " +
  "a signal. If two signals point in different directions, say so plainly " +
  "in the `why` field rather than averaging them or silently picking a " +
  "side. Return only the JSON matching the schema.";

/**
 * Run the SDR-Researcher worker once. `client` is the injected
 * `AnthropicClient` from the caller's deps (offline tests inject a fake;
 * omitted means `runAgent` builds a real client from `ANTHROPIC_API_KEY`).
 */
export async function runSdrResearcher(
  input: SdrResearcherInput,
  client?: AnthropicClient,
): Promise<SdrResearcherOutput> {
  return runAgent({
    model: modelFor("reasoner"),
    system: SDR_RESEARCHER_SYSTEM_PROMPT,
    input,
    outSchema: SdrResearcherOutput,
    client,
  });
}
