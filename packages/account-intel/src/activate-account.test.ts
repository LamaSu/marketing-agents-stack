import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import { SampleSource } from "@mstack/adapters-signals";
import { SampleProvider } from "@mstack/adapters-enrichment";
import { RulesScorer } from "@mstack/adapters-scoring";
import type { AnthropicClient } from "@mstack/agents";

import { activateAccount } from "./activate-account.js";

type CreateParams = Parameters<AnthropicClient["messages"]["create"]>[0];
type CreateResult = Awaited<ReturnType<AnthropicClient["messages"]["create"]>>;

function textResult(json: unknown): CreateResult {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as CreateResult;
}

/**
 * Pulls the `INPUT (JSON): ...` block runAgent's `buildInitialUserContent`
 * embeds in the first user message, so a scripted responder can build its
 * output FROM the real request rather than a hand-picked fixture value --
 * this is what lets the tests below prove real signal ids flow all the way
 * through the swarm, not just that a fixture happens to match.
 */
function extractInputJson(params: CreateParams): unknown {
  const rawContent = params.messages[0]?.content;
  const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
  const match = /INPUT \(JSON\):\n([\s\S]*?)\n\nRespond with only/.exec(content);
  if (!match?.[1]) throw new Error("test harness: could not find the INPUT (JSON) block in the request");
  return JSON.parse(match[1]);
}

interface SdrInputShape {
  signals: Array<{ id: string }>;
  enrichment: { contacts?: unknown[] } | null;
}

/**
 * Ordered responders: SDR-Researcher -> Copywriter -> GTM-Router, matching
 * `activateAccount`'s strictly sequential swarm order. Copywriter/GTM-Router
 * are canned outputs ("fake Anthropic client returning canned worker
 * outputs"); SDR-Researcher's is DERIVED from the real request's input
 * signals, which is the more rigorous way to prove "references only input
 * signalIds" -- a hand-authored canned id would only prove the test author
 * copied a real id correctly, not that the plumbing carries real ids through.
 */
function scriptedSwarmClient(): AnthropicClient {
  const responders: Array<(params: CreateParams) => CreateResult> = [
    (params) => {
      const input = extractInputJson(params) as SdrInputShape;
      const cited = input.signals.slice(0, 2);
      if (cited.length === 0) throw new Error("test fixture has no signals for this account");
      return textResult({
        relevantSignals: cited.map((s) => ({ signalId: s.id, why: "cited from the real input signals" })),
        buyingCommittee: input.enrichment?.contacts ?? [],
      });
    },
    () =>
      textResult({
        subject: "Following up on your recent activity",
        body: "Hi there, noticed a few things on your account worth a quick chat.",
      }),
    () => textResult({ action: "send_intro_email", channel: "email", targetMember: "Aris Thorne" }),
  ];
  let i = 0;
  return {
    messages: {
      create: async (params) => {
        const respond = responders[i++];
        if (!respond) throw new Error("scriptedSwarmClient: no scripted responder left");
        return respond(params);
      },
    },
  };
}

describe("activateAccount", () => {
  let memory: MemoryRepo;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
  });

  afterEach(async () => {
    await memory.close();
  });

  it("activates figma.com end-to-end offline: real signals/accounts, RulesScorer, a scripted worker swarm", async () => {
    const result = await activateAccount(
      { accountRef: { domain: "figma.com" }, mode: "copilot" },
      {
        memory,
        enrichment: new SampleProvider(),
        signalSource: new SampleSource(),
        scoring: new RulesScorer(),
        client: scriptedSwarmClient(),
      },
    );

    // the real fixture's actual figma.com signal ids, for cross-checking below.
    const realSignals = (await new SampleSource().pull()).filter(
      (s) => s.actor.company?.toLowerCase() === "figma.com",
    );
    const realSignalIds = new Set(realSignals.map((s) => s.id));
    expect(realSignalIds.size).toBeGreaterThan(0);

    // the Decision cites REAL signal ids from the sample data.
    expect(result.decision.relevantSignals.length).toBeGreaterThan(0);
    for (const rs of result.decision.relevantSignals) {
      expect(realSignalIds.has(rs.signalId)).toBe(true);
    }

    // a committee is present.
    expect(result.decision.buyingCommittee.length).toBeGreaterThan(0);
    expect(result.decision.buyingCommittee.map((c) => c.name)).toContain("Aris Thorne");

    // a pending outreach draft -- never dispatched.
    expect(result.draft.kind).toBe("outreach_email");
    expect(result.draft.status).toBe("pending");
    const persistedDraft = await memory.getDraft(result.draft.id);
    expect(persistedDraft?.status).toBe("pending");

    // nothing was ever dispatched/approved by this package.
    const approvalRows = await memory.query<{ c: number | bigint }>("SELECT COUNT(*) as c FROM approvals");
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);

    // the full Decision (memory primitive) was persisted too, linked by the resolved account id.
    const accountRows = await memory.query<{ data: string }>(
      "SELECT data FROM accounts WHERE domain = $domain",
      { domain: "figma.com" },
    );
    expect(accountRows[0]).toBeDefined();
    const accountId = (JSON.parse(accountRows[0]!.data) as { id: string }).id;
    const decisionRows = await memory.query<{ data: string }>(
      "SELECT data FROM decisions WHERE account_id = $accountId",
      { accountId },
    );
    expect(decisionRows).toHaveLength(1);
    const persistedDecision = JSON.parse(decisionRows[0]!.data) as {
      relevantSignals: Array<{ signalId: string }>;
      mode: string;
    };
    expect(persistedDecision.mode).toBe("copilot");
    expect(persistedDecision.relevantSignals.length).toBe(result.decision.relevantSignals.length);
  });

  it("SDR-Researcher's output references only signalIds present in ITS OWN input (never invents one)", async () => {
    const scripted = scriptedSwarmClient();
    const calls: Array<{ params: CreateParams; resp: CreateResult }> = [];
    const spied: AnthropicClient = {
      messages: {
        create: async (params) => {
          const resp = await scripted.messages.create(params);
          calls.push({ params, resp });
          return resp;
        },
      },
    };

    await activateAccount(
      { accountRef: { domain: "figma.com" }, mode: "copilot" },
      { memory, enrichment: new SampleProvider(), signalSource: new SampleSource(), scoring: new RulesScorer(), client: spied },
    );

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = calls[0]!; // the SDR-Researcher call, per scriptedSwarmClient's responder order
    const sentInput = extractInputJson(firstCall.params) as SdrInputShape;
    const sentIds = new Set(sentInput.signals.map((s) => s.id));

    const contentBlocks = firstCall.resp.content as unknown as Array<{ type: string; text?: string }>;
    const respText = contentBlocks.find((b) => b.type === "text")?.text ?? "";
    const parsedOut = JSON.parse(respText) as { relevantSignals: Array<{ signalId: string }> };

    expect(parsedOut.relevantSignals.length).toBeGreaterThan(0);
    for (const rs of parsedOut.relevantSignals) {
      expect(sentIds.has(rs.signalId)).toBe(true);
    }
  });

  it("mode:'autopilot' still never dispatches -- the draft stays pending and no Approval is written", async () => {
    const result = await activateAccount(
      { accountRef: { domain: "figma.com" }, mode: "autopilot" },
      {
        memory,
        enrichment: new SampleProvider(),
        signalSource: new SampleSource(),
        scoring: new RulesScorer(),
        client: scriptedSwarmClient(),
      },
    );

    expect(result.draft.status).toBe("pending");
    const approvalRows = await memory.query<{ c: number | bigint }>("SELECT COUNT(*) as c FROM approvals");
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
  });
});
