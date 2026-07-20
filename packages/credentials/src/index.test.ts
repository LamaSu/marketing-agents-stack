import { describe, it, expect } from "vitest";
import {
  LocalBroker,
  GatecraftBroker,
  type GcInvoke,
  openBroker,
  defaultRegistry,
  ProviderRegistry,
  forProvider,
  type BrokerLogEntry,
} from "./index.js";

const SECRET = "shh-do-not-log-me-9f2c";

describe("LocalBroker.resolve", () => {
  it("resolves a fake env key", async () => {
    const broker = new LocalBroker({ env: { FAKE_API_KEY: SECRET }, log: () => {} });
    expect(await broker.resolve("fake", "FAKE_API_KEY")).toBe(SECRET);
  });

  it("returns undefined for a missing key, still logged with found:false", async () => {
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({ env: {}, log: (e) => logs.push(e) });
    const value = await broker.resolve("fake", "MISSING_KEY");
    expect(value).toBeUndefined();
    expect(logs[0]).toMatchObject({ action: "resolve", providerId: "fake", keyName: "MISSING_KEY", found: false });
  });

  it("logs a redacted line -- no secret substring anywhere in the log", async () => {
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({ env: { FAKE_API_KEY: SECRET }, log: (e) => logs.push(e) });
    await broker.resolve("fake", "FAKE_API_KEY");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "resolve", providerId: "fake", keyName: "FAKE_API_KEY", found: true });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

describe("LocalBroker.proxyCall", () => {
  it("injects the resolved secret into the configured header and calls fetch", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const broker = new LocalBroker({ registry, env: { FAKE_API_KEY: SECRET }, fetchImpl: fakeFetch, log: () => {} });

    const res = await broker.proxyCall({
      providerId: "fake",
      method: "GET",
      url: "https://example.com/api/x",
      authInject: { header: "Authorization" },
    });

    expect(capturedUrl).toBe("https://example.com/api/x"); // header injection must NOT touch the url
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(SECRET);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("injects the resolved secret into a query param when authInject.query is used", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({
      registry,
      env: { FAKE_API_KEY: SECRET },
      fetchImpl: fakeFetch,
      log: (e) => logs.push(e),
    });

    await broker.proxyCall({
      providerId: "fake",
      method: "GET",
      url: "https://example.com/api/x",
      authInject: { query: "access_token" },
    });

    expect(capturedUrl).toBe(`https://example.com/api/x?access_token=${SECRET}`);
    // the AUDITED url must stay the pre-injection one -- a query-injected secret must never land in the log.
    expect(logs[0]?.url).toBe("https://example.com/api/x");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("KEY INVARIANT: proxyCall's returned response never leaks the injected secret", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({
      registry,
      env: { FAKE_API_KEY: SECRET },
      fetchImpl: fakeFetch,
      log: (e) => logs.push(e),
    });

    const res = await broker.proxyCall({
      providerId: "fake",
      method: "GET",
      url: "https://example.com/api/x",
      authInject: { header: "Authorization" },
    });

    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("serializes an object body to JSON and defaults content-type", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      capturedInit = init;
      return new Response("{}", { status: 201 });
    };
    const broker = new LocalBroker({ fetchImpl: fakeFetch, log: () => {} });
    const res = await broker.proxyCall({
      providerId: "unregistered",
      method: "POST",
      url: "https://example.com/api/x",
      body: { hello: "world" },
    });
    expect(capturedInit?.body).toBe(JSON.stringify({ hello: "world" }));
    expect((capturedInit?.headers as Record<string, string>)?.["content-type"]).toBe("application/json");
    expect(res.status).toBe(201);
  });
});

describe("GatecraftBroker", () => {
  it("maps resolve() onto an injected gcInvoke, and never logs the resolved value", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const logs: BrokerLogEntry[] = [];
    const gcInvoke: GcInvoke = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "gc_acquire_credential") return { found: true, value: "gc-resolved-secret" };
      throw new Error(`unexpected tool ${tool}`);
    };
    const broker = new GatecraftBroker(gcInvoke, { log: (e) => logs.push(e) });
    const value = await broker.resolve("posthog", "POSTHOG_API_KEY");
    expect(value).toBe("gc-resolved-secret");
    expect(calls[0]).toMatchObject({
      tool: "gc_acquire_credential",
      args: { providerId: "posthog", keyName: "POSTHOG_API_KEY" },
    });
    expect(logs[0]).toMatchObject({ action: "resolve", providerId: "posthog", found: true });
    expect(JSON.stringify(logs)).not.toContain("gc-resolved-secret");
  });

  it("maps proxyCall() onto an injected gcInvoke, passing the registry key hint and mapping the response", async () => {
    const logs: BrokerLogEntry[] = [];
    const gcInvoke: GcInvoke = async (tool, args) => {
      expect(tool).toBe("gc_proxy_call");
      expect(args.providerId).toBe("posthog");
      expect(args.keyNames).toEqual(["POSTHOG_API_KEY"]); // registry hint passed through
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
    };
    const broker = new GatecraftBroker(gcInvoke, { log: (e) => logs.push(e) });
    const res = await broker.proxyCall({
      providerId: "posthog",
      method: "GET",
      url: "https://app.posthog.com/api/x",
      authInject: { header: "Authorization" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(logs[0]).toMatchObject({ action: "proxyCall", providerId: "posthog", status: 200 });
  });

  it("throws a clear error when gcInvoke returns an unexpected shape", async () => {
    const gcInvoke: GcInvoke = async () => "not-a-record";
    const broker = new GatecraftBroker(gcInvoke, { log: () => {} });
    await expect(
      broker.proxyCall({ providerId: "posthog", method: "GET", url: "https://app.posthog.com/api/x" }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("KEY INVARIANT: a provider object cannot read the raw secret", () => {
  it("forProvider() returns an object exposing proxyCall only -- resolve is structurally absent", async () => {
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const fakeFetch: typeof fetch = async () => new Response("{}", { status: 200 });
    const broker = new LocalBroker({ registry, env: { FAKE_API_KEY: SECRET }, fetchImpl: fakeFetch, log: () => {} });

    const proxy = forProvider(broker, "fake");

    expect(typeof proxy.proxyCall).toBe("function");
    expect((proxy as unknown as Record<string, unknown>).resolve).toBeUndefined();
    expect(Object.keys(proxy).sort()).toEqual(["providerId", "proxyCall"]);

    // the proxy still works end-to-end for its one job:
    const res = await proxy.proxyCall({ method: "GET", url: "https://example.com/api/x" });
    expect(res.status).toBe(200);
  });
});

describe("ProviderRegistry / defaultRegistry", () => {
  it("ships posthog / salesforce / resend sample registrations", () => {
    const registry = defaultRegistry();
    expect(registry.get("posthog")?.keyNames).toContain("POSTHOG_API_KEY");
    expect(registry.get("salesforce")?.keyNames).toContain("SALESFORCE_ACCESS_TOKEN");
    expect(registry.get("resend")?.keyNames).toContain("RESEND_API_KEY");
    expect(registry.list().length).toBeGreaterThanOrEqual(3);
  });

  it("returns undefined for an unregistered provider", () => {
    expect(defaultRegistry().get("nope")).toBeUndefined();
  });
});

describe("openBroker", () => {
  it("defaults to LocalBroker when no gcInvoke transport is configured", () => {
    expect(openBroker({ env: {} }).name).toBe("local");
  });

  it("picks GatecraftBroker when a gcInvoke transport is supplied", () => {
    const broker = openBroker({ gcInvoke: async () => ({}) });
    expect(broker.name).toBe("gatecraft");
  });
});
