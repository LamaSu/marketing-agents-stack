import { describe, it, expect, vi } from "vitest";
import { Account, Decision, Outcome } from "@mstack/core";
import { noopCrmSync } from "./crm-sync.js";

function account(overrides: Record<string, unknown> = {}) {
  return Account.parse({
    id: "a1",
    domain: "acme.com",
    name: "Acme Inc",
    firmographic: { tech: [] },
    score: 82,
    tier: "STRONG_FIT",
    lastScoredAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  });
}

function decision(overrides: Record<string, unknown> = {}) {
  return Decision.parse({
    id: "dec1",
    accountId: "a1",
    ts: "2026-07-21T00:00:00.000Z",
    score: 82,
    tier: "STRONG_FIT",
    relevantSignals: [],
    buyingCommittee: [],
    nextBestAction: { action: "email", channel: "email", targetMember: "jane" },
    rationale: "strong ICP fit, active buying committee",
    byAgent: "account-intel",
    mode: "copilot",
    ...overrides,
  });
}

function outcome(overrides: Record<string, unknown> = {}) {
  return Outcome.parse({
    id: "out1",
    refType: "decision",
    refId: "dec1",
    result: "meeting",
    ts: "2026-07-21T00:00:00.000Z",
    ...overrides,
  });
}

describe("noopCrmSync — the offline default (mstack demo's only CrmSync)", () => {
  it("identifies itself as 'noop'", () => {
    expect(noopCrmSync.name).toBe("noop");
  });

  it("pushScore resolves to undefined and logs nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(noopCrmSync.pushScore(account())).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("pushDecision resolves to undefined", async () => {
    await expect(noopCrmSync.pushDecision(decision())).resolves.toBeUndefined();
  });

  it("pushOutcome resolves to undefined", async () => {
    await expect(noopCrmSync.pushOutcome(outcome())).resolves.toBeUndefined();
  });

  it("never touches global fetch — fully offline, no network under any call", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await noopCrmSync.pushScore(account());
      await noopCrmSync.pushDecision(decision());
      await noopCrmSync.pushOutcome(outcome());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tolerates an account with no score/tier yet (nullable fields) — still a clean no-op", async () => {
    await expect(
      noopCrmSync.pushScore(account({ score: null, tier: null, lastScoredAt: null })),
    ).resolves.toBeUndefined();
  });
});
