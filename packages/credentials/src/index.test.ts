import { describe, it, expect } from "vitest";
import {
  LocalBroker,
  GatecraftBroker,
  type GcInvoke,
  openBroker,
  defaultRegistry,
  ProviderRegistry,
  forProvider,
  isUrlWithinBase,
  type BrokerLogEntry,
} from "./index.js";

const SECRET = "shh-do-not-log-me-9f2c";

describe("LocalBroker.resolve", () => {
  it("resolves a registered provider's own key", async () => {
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const broker = new LocalBroker({ registry, env: { FAKE_API_KEY: SECRET }, log: () => {} });
    expect(await broker.resolve("fake", "FAKE_API_KEY")).toBe(SECRET);
  });

  it("returns undefined for a REGISTERED key whose env value is absent, logged found:false", async () => {
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["MISSING_KEY"] });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({ registry, env: {}, log: (e) => logs.push(e) });
    const value = await broker.resolve("fake", "MISSING_KEY");
    expect(value).toBeUndefined();
    expect(logs[0]).toMatchObject({ action: "resolve", providerId: "fake", keyName: "MISSING_KEY", found: false });
  });

  it("logs a redacted line -- no secret substring anywhere in the log", async () => {
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({ registry, env: { FAKE_API_KEY: SECRET }, log: (e) => logs.push(e) });
    await broker.resolve("fake", "FAKE_API_KEY");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "resolve", providerId: "fake", keyName: "FAKE_API_KEY", found: true });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("#10: refuses resolve() for a keyName not registered to the providerId (no arbitrary env reads)", async () => {
    const registry = new ProviderRegistry();
    registry.register({ providerId: "posthog", keyNames: ["POSTHOG_API_KEY"] });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({
      registry,
      env: { POSTHOG_API_KEY: "ph-key", DATABASE_URL: "postgres://u:pw@h/db", AWS_SECRET_ACCESS_KEY: "aws-shh" },
      log: (e) => logs.push(e),
    });
    // a key that exists in env but belongs to no provider is refused (the exfil the audit found):
    await expect(broker.resolve("posthog", "DATABASE_URL")).rejects.toThrow(/not a registered key/i);
    await expect(broker.resolve("posthog", "AWS_SECRET_ACCESS_KEY")).rejects.toThrow(/not a registered key/i);
    // an UNregistered provider is refused too (cannot be used to read any env):
    await expect(broker.resolve("nope", "POSTHOG_API_KEY")).rejects.toThrow(/not a registered key/i);
    // the provider's OWN key still resolves:
    expect(await broker.resolve("posthog", "POSTHOG_API_KEY")).toBe("ph-key");
    // and no unrelated secret ever appears in a log line (even the refused attempts log found:false only):
    expect(JSON.stringify(logs)).not.toContain("postgres://u:pw@h/db");
    expect(JSON.stringify(logs)).not.toContain("aws-shh");
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
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"], baseUrl: "https://example.com" });
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

  it("#4: refuses to inject a secret into a query param (CWE-598) -- never fetches, never leaks", async () => {
    let fetched = false;
    const fakeFetch: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"], baseUrl: "https://example.com" });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({
      registry,
      env: { FAKE_API_KEY: SECRET },
      fetchImpl: fakeFetch,
      log: (e) => logs.push(e),
    });

    await expect(
      broker.proxyCall({
        providerId: "fake",
        method: "GET",
        url: "https://example.com/api/x",
        authInject: { query: "access_token" },
      }),
    ).rejects.toThrow(/query param/i);

    expect(fetched).toBe(false); // secret-in-query is refused before any request goes out...
    expect(JSON.stringify(logs)).not.toContain(SECRET); // ...and the secret never appears anywhere
  });

  it("KEY INVARIANT: proxyCall's returned response never leaks the injected secret", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const registry = new ProviderRegistry();
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"], baseUrl: "https://example.com" });
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

  it("#4: refuses to inject a secret when the URL is off the provider's registered base host", async () => {
    let fetched = false;
    const fetchImpl: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "posthog", keyNames: ["POSTHOG_API_KEY"], baseUrl: "https://app.posthog.com" });
    const logs: BrokerLogEntry[] = [];
    const broker = new LocalBroker({ registry, env: { POSTHOG_API_KEY: SECRET }, fetchImpl, log: (e) => logs.push(e) });

    await expect(
      broker.proxyCall({
        providerId: "posthog",
        method: "GET",
        url: "https://evil.example.com/steal",
        authInject: { header: "Authorization" },
      }),
    ).rejects.toThrow(/refusing to inject/i);

    expect(fetched).toBe(false); // the off-base request is never made...
    expect(JSON.stringify(logs)).not.toContain(SECRET); // ...and the secret never touches a log line
  });

  it("#4: an in-base path on the registered host is still allowed", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "posthog", keyNames: ["POSTHOG_API_KEY"], baseUrl: "https://app.posthog.com" });
    const broker = new LocalBroker({ registry, env: { POSTHOG_API_KEY: SECRET }, fetchImpl, log: () => {} });
    const res = await broker.proxyCall({
      providerId: "posthog",
      method: "GET",
      url: "https://app.posthog.com/api/projects",
      authInject: { header: "Authorization" },
    });
    expect(capturedUrl).toBe("https://app.posthog.com/api/projects");
    expect(res.status).toBe(200);
  });

  it("#4: binds a per-org provider to baseUrlEnv (Salesforce instance URL) and refuses off-instance", async () => {
    const fetches: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      fetches.push(input.toString());
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({
      providerId: "salesforce",
      keyNames: ["SALESFORCE_ACCESS_TOKEN"],
      baseUrlEnv: "SALESFORCE_INSTANCE_URL",
    });
    const broker = new LocalBroker({
      registry,
      env: { SALESFORCE_ACCESS_TOKEN: SECRET, SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com" },
      fetchImpl,
      log: () => {},
    });

    const ok = await broker.proxyCall({
      providerId: "salesforce",
      method: "GET",
      url: "https://acme.my.salesforce.com/services/data/v60.0/sobjects/Lead",
      authInject: { header: "Authorization" },
    });
    expect(ok.status).toBe(200);

    await expect(
      broker.proxyCall({
        providerId: "salesforce",
        method: "GET",
        url: "https://evil.my.salesforce.com/services/data/v60.0/sobjects/Lead",
        authInject: { header: "Authorization" },
      }),
    ).rejects.toThrow(/outside the registered base/i);
    expect(fetches).toHaveLength(1); // only the in-instance call went out
  });

  it("#4: refuses to inject when neither baseUrl nor baseUrlEnv resolves (fail closed)", async () => {
    const fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 });
    const registry = new ProviderRegistry();
    registry.register({ providerId: "unbound", keyNames: ["UNBOUND_KEY"] }); // no base of any kind
    const broker = new LocalBroker({ registry, env: { UNBOUND_KEY: SECRET }, fetchImpl, log: () => {} });
    await expect(
      broker.proxyCall({
        providerId: "unbound",
        method: "GET",
        url: "https://anywhere.example.com/x",
        authInject: { header: "Authorization" },
      }),
    ).rejects.toThrow(/no registered baseUrl/i);
  });

  it("#4: an UNAUTHENTICATED proxy call (no authInject) is unaffected by base binding", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return new Response("{}", { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register({ providerId: "posthog", keyNames: ["POSTHOG_API_KEY"], baseUrl: "https://app.posthog.com" });
    const broker = new LocalBroker({ registry, env: { POSTHOG_API_KEY: SECRET }, fetchImpl, log: () => {} });
    // off-base URL but NO authInject -> no secret to leak -> allowed (plain fetch)
    const res = await broker.proxyCall({ providerId: "posthog", method: "GET", url: "https://cdn.example.com/pub" });
    expect(capturedUrl).toBe("https://cdn.example.com/pub");
    expect(res.status).toBe(200);
  });
});

describe("isUrlWithinBase (destination binding, finding #4)", () => {
  it("matches same scheme+host, allows any path under a host-root base", () => {
    expect(isUrlWithinBase("https://app.posthog.com/api/x", "https://app.posthog.com")).toBe(true);
    expect(isUrlWithinBase("https://app.posthog.com/", "https://app.posthog.com")).toBe(true);
  });
  it("rejects a different host, scheme, or port", () => {
    expect(isUrlWithinBase("https://evil.com/x", "https://app.posthog.com")).toBe(false);
    expect(isUrlWithinBase("http://app.posthog.com/x", "https://app.posthog.com")).toBe(false);
    expect(isUrlWithinBase("https://app.posthog.com:8443/x", "https://app.posthog.com")).toBe(false);
  });
  it("normalizes default port + host case on both sides", () => {
    expect(isUrlWithinBase("HTTPS://APP.PostHog.com:443/x", "https://app.posthog.com")).toBe(true);
  });
  it("enforces a segment-aligned path prefix when the base carries a path", () => {
    expect(isUrlWithinBase("https://api.example.com/v2/x", "https://api.example.com/v2")).toBe(true);
    expect(isUrlWithinBase("https://api.example.com/v2", "https://api.example.com/v2")).toBe(true);
    expect(isUrlWithinBase("https://api.example.com/v2evil", "https://api.example.com/v2")).toBe(false);
  });
  it("fails closed on unparseable input", () => {
    expect(isUrlWithinBase("not-a-url", "https://app.posthog.com")).toBe(false);
    expect(isUrlWithinBase("https://app.posthog.com/x", "not-a-url")).toBe(false);
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
    registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"], baseUrl: "https://example.com" });
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
