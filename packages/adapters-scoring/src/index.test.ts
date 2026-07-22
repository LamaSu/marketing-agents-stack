import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Account, Signal } from "@mstack/core";
import {
  RulesScorer,
  ClaudeScorer,
  OnnxScorer,
  HybridScorer,
  scoringProvider,
  tierForScore,
  featurize,
  decayWeight,
  signalAgeDays,
} from "./index.js";

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

describe("RulesScorer -- fit x intent split + time-decay", () => {
  it("returns fit and intent alongside score; score is the blended headline of both", async () => {
    const scorer = new RulesScorer({ now: fixedClock });
    const result = await scorer.score(account(), [
      signal({ id: "s1", action: "requested_demo" }),
      signal({ id: "s2", kind: "intent", action: "pricing_page_view" }),
    ]);

    expect(typeof result.fit).toBe("number");
    expect(typeof result.intent).toBe("number");
    expect(result.fit).toBeGreaterThan(0);
    expect(result.intent).toBeGreaterThan(0);
    expect(result.score).toBe(Math.min(100, Math.round((result.fit ?? 0) + (result.intent ?? 0))));
  });

  it("fit is firmographic-only and intent is signal-only -- each is 0 when its half of the input is absent", async () => {
    const scorer = new RulesScorer({ now: fixedClock });

    const fitOnly = await scorer.score(account(), []); // rich firmographic, zero signals
    expect(fitOnly.fit).toBeGreaterThan(0);
    expect(fitOnly.intent).toBe(0);

    const intentOnly = await scorer.score(
      account({ firmographic: { employees: null, industry: null, region: null, tech: [] } }),
      [signal({ action: "requested_demo" })],
    );
    expect(intentOnly.fit).toBe(0);
    expect(intentOnly.intent).toBeGreaterThan(0);
  });

  it("decayWeight is 1.0 at age 0, halves at the half-life, and never crashes on non-finite input", () => {
    expect(decayWeight(0, 90)).toBe(1);
    expect(decayWeight(90, 90)).toBeCloseTo(0.5, 10);
    expect(decayWeight(180, 90)).toBeCloseTo(0.25, 10);
    expect(decayWeight(Number.POSITIVE_INFINITY, 90)).toBe(0);
  });

  it("signalAgeDays computes age in days from a Signal's ts, clamped at 0 (never negative)", () => {
    const now = new Date(FIXED_NOW).getTime();
    expect(signalAgeDays(signal({ ts: FIXED_NOW }), now)).toBe(0);
    expect(signalAgeDays(signal({ ts: new Date(now - 10 * 86_400_000).toISOString() }), now)).toBeCloseTo(10, 6);
    expect(signalAgeDays(signal({ ts: new Date(now + 5 * 86_400_000).toISOString() }), now)).toBe(0); // future ts -> clamped, never negative
  });

  it("a stale signal contributes markedly less intent than an identical fresh one (fixed clock, deterministic)", async () => {
    const scorer = new RulesScorer({ now: fixedClock, signalHalfLifeDays: 90 });
    const staleTs = new Date(new Date(FIXED_NOW).getTime() - 180 * 86_400_000).toISOString(); // 2 half-lives old

    const fresh = await scorer.score(account(), [signal({ id: "s1", ts: FIXED_NOW, action: "requested_demo" })]);
    const stale = await scorer.score(account(), [signal({ id: "s1", ts: staleTs, action: "requested_demo" })]);

    expect(fresh.intent).toBeGreaterThan(0);
    expect(stale.intent).toBeGreaterThan(0); // decayed, not zeroed out entirely
    expect(stale.intent as number).toBeLessThan((fresh.intent as number) * 0.5);
  });

  it("a disqualifying signal still floors to DISQUALIFIED (score 0, no fit/intent) even mixed with strong fit + fresh high-intent signals", async () => {
    const scorer = new RulesScorer({ now: fixedClock });
    const result = await scorer.score(account(), [
      signal({ id: "s1", action: "requested_demo" }),
      signal({ id: "s2", kind: "intent", action: "pricing_page_view" }),
      signal({ id: "s3", action: "unsubscribed" }), // disqualifying, mixed in with strong signals
    ]);

    expect(result.tier).toBe("DISQUALIFIED");
    expect(result.score).toBe(0);
    expect(result.fit).toBeUndefined(); // hard-disqualifier path short-circuits before computing sub-scores
    expect(result.intent).toBeUndefined();
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

describe("HybridScorer -- fit/intent passthrough + disqualifier floor unchanged (edge #4)", () => {
  it("a Rules hard-disqualifier still floors the blend even with an injected high-scoring ClaudeScorer", async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ score: 95, tier: "STRONG_FIT", rationale: "looks great" }) }],
        }),
      },
    } as unknown as Anthropic;
    const scorer = new HybridScorer({ claude: new ClaudeScorer({ client: fakeClient }) });

    const result = await scorer.score(account(), [signal({ action: "do_not_contact" })]);

    expect(result.tier).toBe("DISQUALIFIED");
    expect(result.score).toBe(0); // an optimistic 95 from Claude must never rescue a disqualified account
  });

  it("propagates RulesScorer's fit/intent through the non-disqualified default (offline, zero config) blend", async () => {
    const scorer = new HybridScorer();
    const result = await scorer.score(account(), [signal({ action: "requested_demo" })]);

    expect(typeof result.fit).toBe("number");
    expect(typeof result.intent).toBe("number");
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
