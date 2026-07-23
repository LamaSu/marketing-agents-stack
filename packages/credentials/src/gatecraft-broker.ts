/**
 * GatecraftBroker -- maps CredentialBroker onto gatecraft's MCP tool `gc_proxy_call`
 * (mcp__gatecraft__gc_proxy_call), with `resolve()` mapped onto `gc_acquire_credential`.
 * Library code (this package) cannot call an MCP tool directly -- MCP tools are invoked
 * through a connected MCP client, which only exists at the RUNTIME layer (a chorus step, a
 * CLI, an agent harness), not inside a plain npm package. So the actual transport is
 * injected as a `GcInvoke` callback; this class only knows how to shape the request and
 * response, not how the call physically happens.
 *
 * Wiring the real transport lives OUTSIDE this package, e.g. in `packages/runtime`:
 *
 *   import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 *   const mcpClient = new Client(...);            // connected to the gatecraft MCP server
 *   const gcInvoke: GcInvoke = async (tool, args) => {
 *     const result = await mcpClient.callTool({ name: tool, arguments: args });
 *     return result;   // adjust unwrapping to whatever shape the connected client returns
 *   };
 *   const broker = new GatecraftBroker(gcInvoke);
 *
 * `openBroker()` (factory.ts) only picks this broker when a `gcInvoke` is supplied --
 * otherwise it falls back to `LocalBroker`. This package never assumes gatecraft is
 * reachable, and never reads `GATECRAFT_ENDPOINT` itself -- deciding whether to build and
 * inject a real transport is the runtime layer's job (see .env.example).
 */
import { nowIso } from "@mstack/core";
import { type CredentialBroker, type ProxyRequest, type ProxyResponse, type LogSink } from "./types.js";
import { type DpopSigner } from "./dpop.js";
import { consoleLogSink } from "./util.js";
import { ProviderRegistry, defaultRegistry, isUrlWithinBase } from "./registry.js";

/** The injected MCP transport. `tool` is the gatecraft tool name; `args` its arguments. */
export type GcInvoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface GatecraftBrokerOptions {
  registry?: ProviderRegistry;
  log?: LogSink;
  /**
   * OPT-IN DPoP request-binding (RFC 9449). When supplied, a `DPoP` proof (bound to method+url)
   * is added to the forwarded request headers so gatecraft can relay it upstream. Default off.
   */
  dpopSigner?: DpopSigner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class GatecraftBroker implements CredentialBroker {
  readonly name = "gatecraft";
  readonly #gcInvoke: GcInvoke;
  readonly #registry: ProviderRegistry;
  readonly #log: LogSink;
  readonly #dpopSigner: DpopSigner | undefined;

  constructor(gcInvoke: GcInvoke, options: GatecraftBrokerOptions = {}) {
    this.#gcInvoke = gcInvoke;
    this.#registry = options.registry ?? defaultRegistry();
    this.#log = options.log ?? consoleLogSink;
    this.#dpopSigner = options.dpopSigner;
  }

  /**
   * Diagnostic/admin path only (see types.ts doc) -- maps to a gatecraft credential lookup.
   * gatecraft owns the actual secret store; this process never persists what comes back.
   */
  async resolve(providerId: string, keyName: string): Promise<string | undefined> {
    const result = await this.#gcInvoke("gc_acquire_credential", { providerId, keyName });
    const value = isRecord(result) && typeof result.value === "string" ? result.value : undefined;
    this.#log({ ts: nowIso(), action: "resolve", providerId, keyName, found: value !== undefined });
    return value;
  }

  async proxyCall(req: ProxyRequest): Promise<ProxyResponse> {
    const provider = this.#registry.get(req.providerId);

    // #4 (defense in depth): don't even ask gatecraft to inject a secret into an off-base URL.
    // This broker has no env access, so it validates the STATIC `baseUrl` only; per-org providers
    // (`baseUrlEnv`, e.g. Salesforce) are validated by gatecraft server-side. Fires only when
    // authInject requests injection.
    const injectsSecret = req.authInject?.header !== undefined || req.authInject?.query !== undefined;
    const staticBase = provider?.baseUrl;
    if (injectsSecret && staticBase !== undefined && !isUrlWithinBase(req.url, staticBase)) {
      throw new Error(
        `credentials: refusing to proxy a secret injection for provider "${req.providerId}" -- ` +
          `request URL is outside the registered base "${staticBase}".`,
      );
    }
    // OPT-IN: bind the request to the agent key. `htu` inside the proof strips the query, so no
    // gatecraft-injected secret can enter it. Default off -> forwarded headers are unchanged.
    const headers = this.#dpopSigner
      ? { ...(req.headers ?? {}), DPoP: this.#dpopSigner.proof({ htm: req.method, htu: req.url }) }
      : req.headers;
    // Hint gatecraft which env-var-style key names are candidates for this provider,
    // mirroring LocalBroker's own keyNames[0] preference -- gatecraft still owns the
    // actual resolution + injection server-side; the secret never reaches this process.
    const result = await this.#gcInvoke("gc_proxy_call", { ...req, headers, keyNames: provider?.keyNames });

    if (!isRecord(result)) {
      throw new Error(`gatecraft gc_proxy_call: unexpected response shape for provider "${req.providerId}"`);
    }
    const status = typeof result.status === "number" ? result.status : 0;
    const body =
      typeof result.body === "string" ? result.body : result.body === undefined ? "" : JSON.stringify(result.body);

    this.#log({ ts: nowIso(), action: "proxyCall", providerId: req.providerId, method: req.method, url: req.url, status });

    return {
      status,
      headers: isRecord(result.headers) ? (result.headers as Record<string, string>) : {},
      body,
    };
  }
}
