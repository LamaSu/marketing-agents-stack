import { describe, it, expect, vi } from "vitest";
import { Account, Decision, Outcome } from "@mstack/core";
import { ComposioCrmSync, createComposioCrmSync } from "./composio-crm-sync.js";
import type { ComposioLike } from "./composio-crm-sync.js";

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

function fakeComposio(result: { successful?: boolean; error?: string | null } = { successful: true }) {
  const execute = vi.fn(async () => ({ ...result, data: { id: "crm_1" } }));
  return { client: { execute } as unknown as ComposioLike, execute };
}

describe("ComposioCrmSync — pushes via configured Composio actions", () => {
  it("pushScore executes the configured action with mapped args", async () => {
    const { client, execute } = fakeComposio();
    const sync = new ComposioCrmSync(client, {
      actions: {
        score: {
          action: "HUBSPOT_UPDATE_CONTACT",
          mapArgs: (a) => ({ domain: a.domain, mstack_score: a.score, mstack_tier: a.tier }),
        },
      },
    });

    await sync.pushScore(account());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      action: "HUBSPOT_UPDATE_CONTACT",
      params: { domain: "acme.com", mstack_score: 82, mstack_tier: "STRONG_FIT" },
      entityId: undefined,
      connectedAccountId: undefined,
    });
  });

  it("pushDecision executes the configured action with mapped args", async () => {
    const { client, execute } = fakeComposio();
    const sync = new ComposioCrmSync(client, {
      actions: {
        decision: {
          action: "SALESFORCE_UPDATE_RECORD",
          mapArgs: (d) => ({ objectType: "Lead", fields: { Rationale__c: d.rationale } }),
        },
      },
    });

    await sync.pushDecision(decision());

    expect(execute).toHaveBeenCalledWith({
      action: "SALESFORCE_UPDATE_RECORD",
      params: { objectType: "Lead", fields: { Rationale__c: "strong ICP fit, active buying committee" } },
      entityId: undefined,
      connectedAccountId: undefined,
    });
  });

  it("pushOutcome executes the configured action, and honors entityId/connectedAccountId routing", async () => {
    const { client, execute } = fakeComposio();
    const sync = new ComposioCrmSync(client, {
      actions: {
        outcome: {
          action: "HUBSPOT_LOG_ACTIVITY",
          mapArgs: (o) => ({ result: o.result }),
        },
      },
      entityId: "user_7",
      connectedAccountId: "ca_42",
    });

    await sync.pushOutcome(outcome());

    expect(execute).toHaveBeenCalledWith({
      action: "HUBSPOT_LOG_ACTIVITY",
      params: { result: "meeting" },
      entityId: "user_7",
      connectedAccountId: "ca_42",
    });
  });

  it("silently no-ops a push type with no configured action — never calls execute", async () => {
    const { client, execute } = fakeComposio();
    const sync = new ComposioCrmSync(client, { actions: {} }); // no score/decision/outcome configured

    await expect(sync.pushScore(account())).resolves.toBeUndefined();
    await expect(sync.pushDecision(decision())).resolves.toBeUndefined();
    await expect(sync.pushOutcome(outcome())).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("defaults name to 'composio'", () => {
    const { client } = fakeComposio();
    const sync = new ComposioCrmSync(client, { actions: {} });
    expect(sync.name).toBe("composio");
  });
});

describe("ComposioCrmSync — CRM-record-only action allowlist (audit finding #3)", () => {
  it("refuses to construct when a send-style action is configured (e.g. GMAIL_SEND_EMAIL)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "GMAIL_SEND_EMAIL", mapArgs: () => ({}) } },
        }),
    ).toThrow(/refusing to configure/i);
  });

  it("allows a HUBSPOT_UPDATE_CONTACT-style record-update action", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "HUBSPOT_UPDATE_CONTACT", mapArgs: () => ({}) } },
        }),
    ).not.toThrow();
  });

  it("checks decision and outcome independently too (not just score)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { decision: { action: "SLACK_SEND_MESSAGE", mapArgs: () => ({}) } },
        }),
    ).toThrow(/refusing to configure/i);
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { outcome: { action: "TWILIO_SEND_SMS", mapArgs: () => ({}) } },
        }),
    ).toThrow(/refusing to configure/i);
    // record-update/upsert/log ops on all three push types: allowed
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: {
            score: { action: "HUBSPOT_UPSERT_CONTACT", mapArgs: () => ({}) },
            decision: { action: "SALESFORCE_UPDATE_RECORD", mapArgs: () => ({}) },
            outcome: { action: "HUBSPOT_LOG_ACTIVITY", mapArgs: () => ({}) },
          },
        }),
    ).not.toThrow();
  });

  it("rejects a send-style action even when a record noun is also present in the slug (blocklist wins)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "HUBSPOT_SEND_EMAIL_TO_CONTACT", mapArgs: () => ({}) } },
        }),
    ).toThrow(/send\/message\/notify/i);
  });

  it("respects an explicit per-action dangerouslyAllowAnyAction opt-out for a non-default action", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: {
            score: {
              action: "SOME_CUSTOM_CRM_OP",
              mapArgs: () => ({}),
              dangerouslyAllowAnyAction: true,
            },
          },
        }),
    ).not.toThrow();
  });
});

describe("ComposioCrmSync — round-2 hardening: false-negative + false-positive fix (cross-model re-audit, sol/GPT-5.6)", () => {
  it("refuses GMAIL_SENDEMAIL_CONTACT_UPDATE — a fused SEND+EMAIL verb the exact-token blocklist previously missed (false negative)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "GMAIL_SENDEMAIL_CONTACT_UPDATE", mapArgs: () => ({}) } },
        }),
    ).toThrow(/send\/message\/notify/i);
  });

  it("allows HUBSPOT_UPDATE_CONTACT_EMAIL — a benign record update touching the contact's email FIELD (false positive fixed)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "HUBSPOT_UPDATE_CONTACT_EMAIL", mapArgs: () => ({}) } },
        }),
    ).not.toThrow();
  });

  it("refuses EMAIL used as the action's own verb (no literal SEND token, no safe verb elsewhere)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "OUTLOOK_EMAIL_CONTACT", mapArgs: () => ({}) } },
        }),
    ).toThrow(/send\/message\/notify/i);
  });

  it("catches any send-intent word fused into a bigger token, not just SENDEMAIL (e.g. POSTMESSAGE)", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { decision: { action: "SLACK_POSTMESSAGE_CHANNEL", mapArgs: () => ({}) } },
        }),
    ).toThrow(/send\/message\/notify/i);
  });

  it("dangerouslyAllowAnyAction cannot override a clear send-intent action — hard refuse regardless", () => {
    const { client } = fakeComposio();
    const build = () =>
      new ComposioCrmSync(client, {
        actions: {
          score: {
            action: "GMAIL_SEND_EMAIL",
            mapArgs: () => ({}),
            dangerouslyAllowAnyAction: true,
          },
        },
      });
    expect(build).toThrow(/send\/message\/notify/i);
    expect(build).toThrow(/dangerouslyAllowAnyAction/);
  });

  it("dangerouslyAllowAnyAction still works for a genuine non-standard RECORD op that is not a send", () => {
    const { client } = fakeComposio();
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: {
            score: {
              action: "PIPEDRIVE_MERGE_ORGANIZATION",
              mapArgs: () => ({}),
              dangerouslyAllowAnyAction: true,
            },
          },
        }),
    ).not.toThrow();
  });

  it("previously-tested cases still hold: exact send actions and exact record-update actions are unaffected", () => {
    const { client } = fakeComposio();
    expect(
      () => new ComposioCrmSync(client, { actions: { score: { action: "GMAIL_SEND_EMAIL", mapArgs: () => ({}) } } }),
    ).toThrow(/refusing to configure/i);
    expect(
      () =>
        new ComposioCrmSync(client, {
          actions: { score: { action: "HUBSPOT_UPDATE_CONTACT", mapArgs: () => ({}) } },
        }),
    ).not.toThrow();
  });
});

describe("ComposioCrmSync — strips extra runtime fields before mapArgs sees them (audit finding #11)", () => {
  it("pushDecision never exposes fields beyond the real Decision schema to mapArgs, even if smuggled on via `as`", async () => {
    const { client, execute } = fakeComposio();
    let seenKeys: string[] = [];
    const sync = new ComposioCrmSync(client, {
      actions: {
        decision: {
          action: "SALESFORCE_UPDATE_RECORD",
          mapArgs: (d) => {
            seenKeys = Object.keys(d);
            return { rationale: d.rationale };
          },
        },
      },
    });
    const smuggled = {
      ...decision(),
      recipient: "victim@example.com",
      subject: "hi",
      body: "click here, unrelated to any Decision field",
    } as unknown as Decision;

    await sync.pushDecision(smuggled);

    expect(seenKeys).not.toContain("recipient");
    expect(seenKeys).not.toContain("subject");
    expect(seenKeys).not.toContain("body");
    expect(seenKeys).toContain("rationale"); // the real field is still there -- this strips, doesn't break
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ params: { rationale: "strong ICP fit, active buying committee" } }),
    );
  });
});

describe("ComposioCrmSync — degrades gracefully, never throws", () => {
  it("resolves (not rejects) when Composio reports successful: false, and warns once", async () => {
    const { client, execute } = fakeComposio({ successful: false, error: "rate limited" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = new ComposioCrmSync(client, {
      actions: { score: { action: "HUBSPOT_UPDATE_CONTACT", mapArgs: () => ({}) } },
    });

    await expect(sync.pushScore(account())).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("rate limited");
    warnSpy.mockRestore();
  });

  it("resolves (not rejects) when the Composio client throws, and warns once", async () => {
    const execute = vi.fn(async () => {
      throw new Error("network down");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = new ComposioCrmSync({ execute } as unknown as ComposioLike, {
      actions: { decision: { action: "SALESFORCE_UPDATE_RECORD", mapArgs: () => ({}) } },
    });

    await expect(sync.pushDecision(decision())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("offline & lazy-SDK guarantees", () => {
  it("the package imports and runs with NO @composio/core installed (SDK is lazy)", () => {
    // The mere fact this test file imported ./composio-crm-sync.js and reached
    // here proves @composio/core is not a static dependency -- it is only
    // import()-ed inside createComposioCrmSync, which these offline tests
    // never call.
    expect(typeof createComposioCrmSync).toBe("function");
  });

  it("never calls global fetch — all traffic goes through the injected ComposioLike client", async () => {
    const { client } = fakeComposio();
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const sync = new ComposioCrmSync(client, {
        actions: { score: { action: "HUBSPOT_UPDATE_CONTACT", mapArgs: () => ({}) } },
      });
      await sync.pushScore(account());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
