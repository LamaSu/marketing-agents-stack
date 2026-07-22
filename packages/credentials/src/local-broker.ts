/**
 * LocalBroker -- the default, offline credential broker. Resolves keys from exactly one
 * audited place inside this class (`#readEnv`), sourced from env vars (e.g.
 * SALESFORCE_ACCESS_TOKEN, POSTHOG_API_KEY -- see .env.example). No other file in this
 * package (or any caller) reads process.env for a credential. Every resolve/proxy call is
 * logged -- providerId + keyName + timestamp only, NEVER the value -- to an injectable sink
 * (defaults to console; see util.ts `consoleLogSink`).
 */
import { nowIso } from "@mstack/core";
import { type CredentialBroker, type ProxyRequest, type ProxyResponse, type LogSink } from "./types.js";
import { type DpopSigner } from "./dpop.js";
import { consoleLogSink } from "./util.js";
import { ProviderRegistry, defaultRegistry } from "./registry.js";

export interface LocalBrokerOptions {
  registry?: ProviderRegistry;
  /** injectable for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  log?: LogSink;
  /**
   * OPT-IN request-binding (RFC 9449). When supplied, each proxyCall attaches a `DPoP` proof
   * header bound to (method, url). Omit (the default) and behavior is byte-for-byte unchanged --
   * the offline `mstack demo` path never sets this. See dpop.ts.
   */
  dpopSigner?: DpopSigner;
}

export class LocalBroker implements CredentialBroker {
  readonly name = "local";
  readonly #registry: ProviderRegistry;
  readonly #env: Record<string, string | undefined>;
  readonly #fetchImpl: typeof fetch;
  readonly #log: LogSink;
  readonly #dpopSigner: DpopSigner | undefined;

  constructor(options: LocalBrokerOptions = {}) {
    this.#registry = options.registry ?? defaultRegistry();
    this.#env = options.env ?? process.env;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#log = options.log ?? consoleLogSink;
    this.#dpopSigner = options.dpopSigner;
  }

  /** The ONE place this class touches env. The value never leaves this method un-redacted. */
  #readEnv(keyName: string): string | undefined {
    return this.#env[keyName];
  }

  async resolve(providerId: string, keyName: string): Promise<string | undefined> {
    const value = this.#readEnv(keyName);
    this.#log({ ts: nowIso(), action: "resolve", providerId, keyName, found: value !== undefined });
    return value;
  }

  async proxyCall(req: ProxyRequest): Promise<ProxyResponse> {
    const provider = this.#registry.get(req.providerId);
    const keyName = provider?.keyNames[0];
    const secret = keyName ? this.#readEnv(keyName) : undefined;

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    // OPT-IN: bind this request to the agent key. `htu` (inside proof) strips the query, so a
    // query-injected secret below can never enter the proof. Bound to req.url (pre-injection).
    if (this.#dpopSigner) headers["DPoP"] = this.#dpopSigner.proof({ htm: req.method, htu: req.url });
    let url = req.url;
    const headerName = req.authInject?.header;
    const queryName = req.authInject?.query;
    if (secret && headerName) headers[headerName] = secret;
    if (secret && queryName) {
      const withQuery = new URL(url);
      withQuery.searchParams.set(queryName, secret);
      url = withQuery.toString();
    }

    let body: string | undefined;
    if (typeof req.body === "string") {
      body = req.body;
    } else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
    }

    const res = await this.#fetchImpl(url, { method: req.method, headers, body });

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    const resBody = await res.text();

    // Log the ORIGINAL request url, never the (possibly query-injected) outbound one --
    // a query-based authInject would otherwise leak the secret into the audit log.
    this.#log({
      ts: nowIso(),
      action: "proxyCall",
      providerId: req.providerId,
      keyName,
      found: secret !== undefined,
      method: req.method,
      url: req.url,
      status: res.status,
    });

    return { status: res.status, headers: resHeaders, body: resBody };
  }
}
