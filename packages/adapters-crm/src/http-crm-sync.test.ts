import { describe, it, expect, vi } from "vitest";
import { Account, Decision, Outcome } from "@mstack/core";
import { createHttpCrmSync } from "./http-crm-sync.js";

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

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake `fetch` that records every call (url/method/headers/parsed-JSON-body)
 *  into a plain array via closure -- avoids indexing `mock.calls` (and the
 *  `noUncheckedIndexedAccess`-vs-tuple-assertion friction that comes with it)
 *  entirely. `respond` controls what each call resolves/rejects to. */
function fakeFetch(respond: () => Promise<{ ok: boolean; status: number }>) {
  const requests: CapturedRequest[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return respond();
  });
  return { fetchImpl: fn as unknown as typeof fetch, requests };
}

describe("createHttpCrmSync — POSTs the right payload on success", () => {
  it("pushScore POSTs domain/score/tier/lastScoredAt to /accounts/{domain}/score with a Bearer header", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com/", apiKey: "k-1", fetchImpl });

    await sync.pushScore(account());

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req).toBeDefined();
    expect(req?.url).toBe("https://crm.example.com/accounts/acme.com/score");
    expect(req?.method).toBe("POST");
    expect(req?.headers["Authorization"]).toBe("Bearer k-1");
    expect(req?.body).toEqual({
      domain: "acme.com",
      score: 82,
      tier: "STRONG_FIT",
      lastScoredAt: "2026-07-21T00:00:00.000Z",
    });
  });

  it("pushScore sends explicit nulls for a not-yet-scored account (never omits the fields)", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });

    await sync.pushScore(account({ score: null, tier: null, lastScoredAt: null }));

    expect(requests[0]?.body).toEqual({
      domain: "acme.com",
      score: null,
      tier: null,
      lastScoredAt: null,
    });
  });

  it("pushDecision POSTs the full Decision to /decisions", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });
    const d = decision();

    await sync.pushDecision(d);

    expect(requests[0]?.url).toBe("https://crm.example.com/decisions");
    expect(requests[0]?.body).toEqual(d);
  });

  it("pushOutcome POSTs the full Outcome to /outcomes", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });
    const o = outcome();

    await sync.pushOutcome(o);

    expect(requests[0]?.url).toBe("https://crm.example.com/outcomes");
    expect(requests[0]?.body).toEqual(o);
  });

  it("uses query-style auth when authStyle: 'query' is configured, and omits the header", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({
      baseUrl: "https://crm.example.com",
      apiKey: "k-1",
      authStyle: "query",
      queryParamName: "hapikey",
      fetchImpl,
    });

    await sync.pushScore(account());

    expect(requests[0]?.url).toBe("https://crm.example.com/accounts/acme.com/score?hapikey=k-1");
    expect(requests[0]?.headers["Authorization"]).toBeUndefined();
  });
});

describe("createHttpCrmSync — projects away extra runtime fields before POSTing (audit finding #11)", () => {
  it("pushDecision only POSTs the real Decision fields, even if extra fields were smuggled onto the object", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });
    const d = decision();
    const smuggled = {
      ...d,
      recipient: "victim@example.com",
      subject: "hi",
      body: "click here, unrelated to any Decision field",
    } as unknown as Decision;

    await sync.pushDecision(smuggled);

    expect(requests[0]?.body).toEqual(d);
    expect(requests[0]?.body).not.toHaveProperty("recipient");
    expect(requests[0]?.body).not.toHaveProperty("subject");
    expect(requests[0]?.body).not.toHaveProperty("body");
  });

  it("pushOutcome only POSTs the real Outcome fields, even if extra fields were smuggled onto the object", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });
    const o = outcome();
    const smuggled = { ...o, recipient: "victim@example.com", channel: "email" } as unknown as Outcome;

    await sync.pushOutcome(smuggled);

    expect(requests[0]?.body).toEqual(o);
    expect(requests[0]?.body).not.toHaveProperty("recipient");
    expect(requests[0]?.body).not.toHaveProperty("channel");
  });

  it("degrades to a warning (never throws/rejects) when the payload genuinely fails Decision validation", async () => {
    const { fetchImpl, requests } = fakeFetch(async () => ({ ok: true, status: 200 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });
    const malformed = { id: "dec1" } as unknown as Decision; // missing every other required field

    await expect(sync.pushDecision(malformed)).resolves.toBeUndefined();

    expect(requests).toHaveLength(0); // never POSTed -- validation failed before the fetch call
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("schema validation");
    warnSpy.mockRestore();
  });
});

describe("createHttpCrmSync — degrades gracefully, never throws", () => {
  it("resolves (not rejects) when the CRM endpoint is unreachable, and warns once", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });

    await expect(sync.pushScore(account())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("resolves (not rejects) on a non-OK response, and warns once with the status code", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({ baseUrl: "https://crm.example.com", apiKey: "k-1", fetchImpl });

    await expect(sync.pushDecision(decision())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("500");
    warnSpy.mockRestore();
  });

  it("aborts and degrades to no-op when the request hangs past timeoutMs", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({
      baseUrl: "https://crm.example.com",
      apiKey: "k-1",
      fetchImpl,
      timeoutMs: 30,
    });

    await expect(sync.pushOutcome(outcome())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("createHttpCrmSync — secret hygiene", () => {
  it("never leaks a query-injected secret into a warning log", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({
      baseUrl: "https://crm.example.com",
      apiKey: "SUPER-SECRET-KEY",
      authStyle: "query",
      fetchImpl,
    });

    await sync.pushScore(account());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedMessage = String(warnSpy.mock.calls[0]?.[0]);
    expect(loggedMessage).not.toContain("SUPER-SECRET-KEY");
    expect(loggedMessage).toContain("[REDACTED]");
    warnSpy.mockRestore();
  });

  it("never logs the raw apiKey even when the thrown error message echoes the request URL", async () => {
    const fetchImpl = vi.fn((url: string) => {
      throw new Error(`fetch failed for ${url}`);
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({
      baseUrl: "https://crm.example.com",
      apiKey: "SUPER-SECRET-KEY",
      authStyle: "query",
      fetchImpl,
    });

    await sync.pushScore(account());

    const loggedMessage = String(warnSpy.mock.calls[0]?.[0]);
    expect(loggedMessage).not.toContain("SUPER-SECRET-KEY");
    warnSpy.mockRestore();
  });

  it("never logs the raw apiKey in header mode either (key never enters the URL)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = createHttpCrmSync({
      baseUrl: "https://crm.example.com",
      apiKey: "SUPER-SECRET-KEY",
      fetchImpl, // authStyle defaults to "header"
    });

    await sync.pushScore(account());

    const loggedMessage = String(warnSpy.mock.calls[0]?.[0]);
    expect(loggedMessage).not.toContain("SUPER-SECRET-KEY");
    warnSpy.mockRestore();
  });
});
