/**
 * Copywriter -- the second swarm worker (research/06-architecture.md §3.2).
 * Drafts ONE personalized outreach message from the resolved committee +
 * relevant signals + a brand-voice note. No sending, no routing.
 *
 * The worker's own output is content ONLY (`subject`/`body`) -- it never
 * mints a persistence id, sets a `refId`, or touches a `Draft`'s `status`.
 * `activateAccount` (not this worker) wraps the content into a
 * `Draft{kind:'outreach_email', status:'pending'}`. This mirrors the
 * `FindingDraft`/`Finding` split already established in `@mstack/core` for
 * the reviewer package: the model returns *content*, orchestration code
 * assembles the persisted, id-bearing record.
 */
import { z } from "zod";
import { modelFor } from "@mstack/core";
import type { RelevantSignal, CommitteeMember } from "@mstack/core";
import { runAgent } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

export const CopywriterOutput = z.object({
  subject: z.string(),
  body: z.string(),
});
export type CopywriterOutput = z.infer<typeof CopywriterOutput>;

export interface CopywriterInput {
  account: { domain: string; name: string };
  committee: CommitteeMember[];
  relevantSignals: RelevantSignal[];
  /** a short brand-voice note (tone/style guidance) -- not marketing copy to insert verbatim. */
  brandVoice: string;
}

export const DEFAULT_BRAND_VOICE =
  "Direct, specific, and low-hype. Reference the account's own signals, not generic value props. Two short paragraphs at most, one clear ask.";

export const COPYWRITER_SYSTEM_PROMPT =
  "You produce ONE personalized outreach email draft for a single B2B " +
  "account. Ground every sentence in the buying committee and relevant " +
  "signals provided in the input -- do not invent facts about the account, " +
  "its people, or its product usage. Address whichever committee member the " +
  "signals make most relevant. Follow the brand-voice note for tone. This " +
  "is a DRAFT ONLY: you are not sending this message, and nothing you " +
  "produce is dispatched automatically -- a human approves every send " +
  "before anything goes out. Return only the JSON matching the schema (a " +
  "subject line and a body).";

/**
 * Run the Copywriter worker once. `client` is the injected `AnthropicClient`
 * from the caller's deps (offline tests inject a fake; omitted means
 * `runAgent` builds a real client from `ANTHROPIC_API_KEY`).
 */
export async function runCopywriter(
  input: CopywriterInput,
  client?: AnthropicClient,
): Promise<CopywriterOutput> {
  return runAgent({
    model: modelFor("copywriter"),
    system: COPYWRITER_SYSTEM_PROMPT,
    input,
    outSchema: CopywriterOutput,
    client,
  });
}
