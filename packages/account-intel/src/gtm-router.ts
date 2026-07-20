/**
 * GTM-Router -- the third swarm worker (research/06-architecture.md §3.2).
 * Classifies the next-best-action + channel + target committee member.
 * Classification only -- no drafting, no sending. Routed to haiku via
 * `modelFor('router')` per the task's explicit model routing (cheap,
 * high-volume classification, `@mstack/core`'s model map).
 *
 * Its output schema is `NextBestAction`, reused directly from `@mstack/core`
 * rather than redefined here -- the worker's contract and the persisted
 * `Decision.nextBestAction` field are exactly the same shape, no adapter
 * needed between them.
 */
import { NextBestAction, modelFor } from "@mstack/core";
import type { CommitteeMember, RelevantSignal, AccountTier } from "@mstack/core";
import { runAgent } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

export interface GtmRouterInput {
  committee: CommitteeMember[];
  score: number;
  tier: AccountTier;
  relevantSignals: RelevantSignal[];
}

export const GTM_ROUTER_SYSTEM_PROMPT =
  "You classify the next-best-action for one account. Given its buying " +
  "committee, fit score and tier, and the relevant signals already " +
  "identified, choose ONE next action, a channel, and which committee " +
  "member to target. This is classification only -- you do not draft " +
  "messages and you do not send anything. Return only the JSON matching " +
  "the schema.";

/**
 * Run the GTM-Router worker once. `client` is the injected `AnthropicClient`
 * from the caller's deps (offline tests inject a fake; omitted means
 * `runAgent` builds a real client from `ANTHROPIC_API_KEY`).
 */
export async function runGtmRouter(
  input: GtmRouterInput,
  client?: AnthropicClient,
): Promise<NextBestAction> {
  return runAgent({
    model: modelFor("router"),
    system: GTM_ROUTER_SYSTEM_PROMPT,
    input,
    outSchema: NextBestAction,
    client,
  });
}
