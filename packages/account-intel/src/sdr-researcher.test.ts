import { describe, it, expect } from "vitest";
import { checkPromptHygiene } from "@mstack/agents";
import type { AnthropicClient } from "@mstack/agents";

import { runSdrResearcher, SDR_RESEARCHER_SYSTEM_PROMPT } from "./sdr-researcher.js";

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

describe("SDR_RESEARCHER_SYSTEM_PROMPT", () => {
  it("passes prompt hygiene -- job-as-function, no identity inflation, no panic framing", () => {
    expect(checkPromptHygiene(SDR_RESEARCHER_SYSTEM_PROMPT)).toEqual([]);
  });

  it("instructs the model to cite only input signalIds and never invent one", () => {
    expect(SDR_RESEARCHER_SYSTEM_PROMPT).toMatch(/never invent a signal/i);
  });

  it("instructs the model to surface conflicts rather than average them", () => {
    expect(SDR_RESEARCHER_SYSTEM_PROMPT).toMatch(/rather than averaging/i);
  });
});

describe("runSdrResearcher", () => {
  it("returns schema-valid relevantSignals + buyingCommittee from a canned worker output", async () => {
    const client = fakeClientReturning({
      relevantSignals: [{ signalId: "sig_0001", why: "requested a demo last week" }],
      buyingCommittee: [{ name: "Aris Thorne", role: "SVP Engineering", persona: "Engineering" }],
    });

    const out = await runSdrResearcher(
      { account: { domain: "figma.com", name: "Figma" }, signals: [], enrichment: null },
      client,
    );

    expect(out.relevantSignals).toEqual([{ signalId: "sig_0001", why: "requested a demo last week" }]);
    expect(out.buyingCommittee[0]?.name).toBe("Aris Thorne");
  });
});
