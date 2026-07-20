import { describe, it, expect } from "vitest";
import { Account, Signal } from "@mstack/core";
import { RulesScorer } from "@mstack/adapters-scoring";

import { rankAccounts } from "./ranking.js";

function account(domain: string, overrides: Record<string, unknown> = {}): Account {
  return Account.parse({
    id: `acc_${domain}`,
    domain,
    name: domain,
    firmographic: { employees: 10, tech: [] },
    ...overrides,
  });
}

describe("rankAccounts", () => {
  it("scores every account (deterministically, via an injected RulesScorer), sorts descending, and returns only the top N", async () => {
    const strong = account("strong.com", {
      firmographic: { employees: 5000, industry: "software", region: "US", tech: ["react", "aws", "segment"] },
    });
    const weak = account("weak.com", { firmographic: { employees: 2, tech: [] } });
    const mid = account("mid.com", { firmographic: { employees: 100, industry: "software", tech: [] } });

    const ranked = await rankAccounts([weak, strong, mid], {}, 2, new RulesScorer());

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.domain).toBe("strong.com");
    expect(ranked.every((a) => typeof a.score === "number" && a.tier !== null && a.lastScoredAt !== null)).toBe(true);
    expect(ranked.map((a) => a.domain)).not.toContain("weak.com"); // the noise filter drops the low scorer
  });

  it("slices safely when topN exceeds the input length", async () => {
    const one = account("only.com");
    const ranked = await rankAccounts([one], {}, 10, new RulesScorer());
    expect(ranked).toHaveLength(1);
  });

  it("returns an empty array for an empty input, without throwing", async () => {
    expect(await rankAccounts([], {}, 5, new RulesScorer())).toEqual([]);
  });

  it("looks up each account's signals by domain via signalsByAccount", async () => {
    const acct = account("signaled.com", { firmographic: { employees: 10, tech: [] } });
    const signals = [
      Signal.parse({
        id: "s1",
        ts: "2026-07-01T00:00:00.000Z",
        source: "sample",
        kind: "intent",
        actor: { company: "signaled.com" },
        action: "requested_demo",
      }),
    ];

    const withoutSignals = await rankAccounts([acct], {}, 1, new RulesScorer());
    const withSignals = await rankAccounts([acct], { "signaled.com": signals }, 1, new RulesScorer());

    expect(withSignals[0]?.score ?? 0).toBeGreaterThan(withoutSignals[0]?.score ?? 0);
  });
});
