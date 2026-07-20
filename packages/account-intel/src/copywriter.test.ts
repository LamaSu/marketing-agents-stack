import { describe, it, expect } from "vitest";
import { checkPromptHygiene } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

import { runCopywriter, COPYWRITER_SYSTEM_PROMPT, DEFAULT_BRAND_VOICE } from "./copywriter.js";

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

describe("COPYWRITER_SYSTEM_PROMPT", () => {
  it("passes prompt hygiene -- job-as-function, no identity inflation, no panic framing", () => {
    expect(checkPromptHygiene(COPYWRITER_SYSTEM_PROMPT)).toEqual([]);
  });

  it("makes the draft-only / no-sending constraint explicit", () => {
    expect(COPYWRITER_SYSTEM_PROMPT).toMatch(/draft only/i);
    expect(COPYWRITER_SYSTEM_PROMPT).toMatch(/human approves every send/i);
  });
});

describe("runCopywriter", () => {
  it("returns a subject + body from a canned worker output", async () => {
    const client = fakeClientReturning({
      subject: "Quick question about your rollout",
      body: "Hi Aris, noticed the recent renewal conversation -- worth a quick chat?",
    });

    const out = await runCopywriter(
      {
        account: { domain: "figma.com", name: "Figma" },
        committee: [],
        relevantSignals: [],
        brandVoice: DEFAULT_BRAND_VOICE,
      },
      client,
    );

    expect(out.subject).toBe("Quick question about your rollout");
    expect(out.body).toContain("Aris");
  });
});
