import { describe, it, expect } from "vitest";
import { checkPromptHygiene } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

import { runGtmRouter, GTM_ROUTER_SYSTEM_PROMPT } from "./gtm-router.js";

type CreateResult = Awaited<ReturnType<AnthropicClient["messages"]["create"]>>;

function fakeClientReturning(json: unknown): AnthropicClient {
  return {
    messages: {
      create: async () =>
        ({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: JSON.stringify(json) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }) as unknown as CreateResult,
    },
  };
}

describe("GTM_ROUTER_SYSTEM_PROMPT", () => {
  it("passes prompt hygiene -- job-as-function, no identity inflation, no panic framing", () => {
    expect(checkPromptHygiene(GTM_ROUTER_SYSTEM_PROMPT)).toEqual([]);
  });
});

describe("runGtmRouter", () => {
  it("returns a NextBestAction from a canned worker output", async () => {
    const client = fakeClientReturning({ action: "send_intro_email", channel: "email", targetMember: "Aris Thorne" });

    const out = await runGtmRouter(
      { committee: [], score: 80, tier: "STRONG_FIT", relevantSignals: [] },
      client,
    );

    expect(out).toEqual({ action: "send_intro_email", channel: "email", targetMember: "Aris Thorne" });
  });
});
