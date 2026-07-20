import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Account, Signal } from "@mstack/core";
import { RulesScorer, ClaudeScorer, OnnxScorer, HybridScorer, scoringProvider, tierForScore, featurize } from "./index.js";

const FIXED_NOW = "2026-07-20T00:00:00.000Z";
const fixedClock = () => new Date(FIXED_NOW).getTime();

function account(overrides: Record<string, unknown> = {}) {
  return Account.parse({
    id: "acc_1",
    domain: "figma.com",
    name: "Figma",
    firmographic: {
      employees: 1500,
      industry: "Design & Collaboration Software",
      region: "US",
      tech: ["react", "aws", "segment"],
    },
    ...overrides,
  });
}

function signal(overrides: Record<string, unknown> = {}) {
  return Signal.parse({
    id: "sig_1",
    ts: FIXED_NOW,
    source: "sample",
    kind: "product_usage",
    actor: { company: "figma.com" },
    ...overrides,
  });
}

describe("RulesScorer", () => {
  it("scores a well-fit sample account deterministically, fully offline", async () => {
    const scorer = new RulesScorer({ now: fixedClock });
    const acct = account();
    const signals = [
      signal({ id: "s1", action: "requested_demo" }),
      signal({ id: "s2", kind: "intent", action: "pricing_page_view" }),
      signal({ id: "s3", kind: "crm" }),
    ];

    const first = await scorer.score(acct, signals);
    const second = await scorer.score(acct, signals);

    expect(first).toEqual(second); // same input -> same output, every time
    expect(first.score).toBeGreaterThan(0);
    expect(first.tier).not.toBe("DISQUALIFIED");
    expect(first.rationale).toContain("employees");
    expect(first.rationale).toContain("target industry");
  });

  it("maps a disqualifying signal to DISQUALIFIED regardless of firmographic strength", async () => {
    const scorer = new RulesScorer();
    const acct = account(); // otherwise a strong-fit account
    const result = await scorer.score(acct, [signal({ action: "unsubscribed" })]);

    expect(result.tier).toBe("DISQUALIFIED");
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("unsubscribed");
  });

  it("scores a sparse account (no firmographic data, no signals) low without crashing", async () => {
    const scorer = new RulesScorer();
    const acct = account({ firmographic: { employees: null, industry: null, region: null, tech: [] } });
    const result = await scorer.score(acct, []);
    expect(result.score).toBe(0);
    expect(result.tier).toBe("DISQUALIFIED");
  });
});

describe("HybridScorer", () => {
  it("with no Claude client and no ONNX model, returns rules-only and cites it in the rationale", async () => {
    const scorer = new HybridScorer(); // zero config -- must stay fully offline
    const result = await scorer.score(account(), [signal()]);

    expect(result.rationale).toContain("rules");
    expect(result.rationale).not.toContain("claude");
    expect(result.rationale).not.toContain("onnx");
  });

  it("carries a Rules disqualifier through the default (no Claude/Onnx) blend", async () => {
    const scorer = new HybridScorer();
    const result = await scorer.score(account(), [signal({ action: "do_not_contact" })]);
    expect(result.tier).toBe("DISQUALIFIED");
  });

  it("blends in an injected ClaudeScorer's score, offline via a fake client", async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ score: 90, tier: "STRONG_FIT", rationale: "strong engagement signals" }) }],
        }),
      },
    } as unknown as Anthropic;
    const scorer = new HybridScorer({ claude: new ClaudeScorer({ client: fakeClient }) });

    const result = await scorer.score(account(), [signal()]);

    expect(result.rationale).toContain("claude=90");
    expect(result.score).toBeGreaterThanOrEqual(90); // blend = max(rules, weighted(...claude)) >= 90
  });

  it("degrades past a Claude failure without throwing", async () => {
    const failingClient = {
      messages: {
        create: async () => {
          throw new Error("network down");
        },
      },
    } as unknown as Anthropic;
    const scorer = new HybridScorer({ claude: new ClaudeScorer({ client: failingClient }) });

    const result = await scorer.score(account(), [signal()]);

    expect(result.rationale).toContain("rules");
    expect(result.rationale).not.toContain("claude");
  });
});

describe("ClaudeScorer", () => {
  it("is injectable and runs fully offline against a fake client", async () => {
    const fakeClient = {
      messages: {
        create: async (params: { model: string; messages: Array<{ content: string }> }) => {
          expect(params.model).toBeTruthy();
          expect(params.messages[0]?.content).toContain("figma.com");
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ score: 82, tier: "STRONG_FIT", rationale: "large target-industry account" }) }],
          };
        },
      },
    } as unknown as Anthropic;

    const scorer = new ClaudeScorer({ client: fakeClient });
    const result = await scorer.score(account(), [signal()]);

    expect(result).toEqual({ score: 82, tier: "STRONG_FIT", rationale: "large target-industry account" });
  });

  it("throws a clear error on refusal instead of returning a bogus score", async () => {
    const fakeClient = {
      messages: {
        create: async () => ({ stop_reason: "refusal", content: [] }),
      },
    } as unknown as Anthropic;

    const scorer = new ClaudeScorer({ client: fakeClient });
    await expect(scorer.score(account(), [])).rejects.toThrow(/refused/);
  });
});

describe("OnnxScorer", () => {
  it("reports unavailable (never throws) when no model file exists, offline", async () => {
    const scorer = new OnnxScorer({ modelPath: "/definitely/does/not/exist/model.onnx" });
    expect(scorer.available).toBe(false);
    await expect(scorer.score(account(), [])).rejects.toThrow(/no model/);
    expect(scorer.available).toBe(false); // still false after the failed attempt -- no crash, no half-state
  });

  it("featurize() produces a fixed-length, finite numeric vector", () => {
    const vec = featurize(account(), [signal()]);
    expect(vec).toHaveLength(5);
    expect(vec.every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe("scoringProvider factory", () => {
  it("defaults to a HybridScorer instance", () => {
    expect(scoringProvider().name).toBe("hybrid");
  });

  it("constructs a RulesScorer by name", () => {
    expect(scoringProvider("rules").name).toBe("rules");
  });
});

describe("tierForScore", () => {
  it("maps score bands to the four AccountTier values", () => {
    expect(tierForScore(90)).toBe("STRONG_FIT");
    expect(tierForScore(60)).toBe("FIT");
    expect(tierForScore(30)).toBe("PARTIAL_FIT");
    expect(tierForScore(10)).toBe("DISQUALIFIED");
  });
});
