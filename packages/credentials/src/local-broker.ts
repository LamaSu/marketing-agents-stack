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
import { ProviderRegistry, defaultRegistry, isUrlWithinBase, type ProviderConfig } from "./registry.js";

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

  /** Resolve a provider's destination allow-base: static `baseUrl`, else per-org `baseUrlEnv`. */
  #allowedBase(provider: ProviderConfig | undefined): string | undefined {
    if (provider?.baseUrl !== undefined) return provider.baseUrl;
    if (provider?.baseUrlEnv !== undefined) return this.#readEnv(provider.baseUrlEnv);
    return undefined;
  }

  /**
   * #4 destination binding. Throw unless `url` is within the provider's registered base -- called
   * BEFORE the secret is read, so an off-base URL means the secret is never loaded, never injected,
   * never sent. The thrown message carries the provider id + base (config, not a secret), never the
   * secret or the caller URL.
   */
  #assertUrlWithinBase(provider: ProviderConfig | undefined, url: string): void {
    const who = provider?.providerId ?? "(unregistered)";
    const base = this.#allowedBase(provider);
    if (base === undefined || base === "") {
      throw new Error(
        `credentials: refusing to inject a secret for provider "${who}" -- no registered baseUrl ` +
          `(or baseUrlEnv) to bind the destination to. Register a base, or omit authInject for an ` +
          `unauthenticated call.`,
      );
    }
    if (!isUrlWithinBase(url, base)) {
      throw new Error(
        `credentials: refusing to inject a secret for provider "${who}" -- request URL is outside ` +
          `the registered base "${base}".`,
      );
    }
  }

  async resolve(providerId: string, keyName: string): Promise<string | undefined> {
    // #10: bind keyName to the provider. resolve() is a trusted diagnostic path, but it must NOT
    // be usable to read an arbitrary env var -- resolve("posthog","DATABASE_URL") is refused so a
    // provider can never be steered to return an unrelated secret. Unregistered provider -> refused.
    const provider = this.#registry.get(providerId);
    if (!provider?.keyNames.includes(keyName)) {
      this.#log({ ts: nowIso(), action: "resolve", providerId, keyName, found: false });
      throw new Error(
        `credentials: resolve("${providerId}", "${keyName}") refused -- "${keyName}" is not a ` +
          `registered key for provider "${providerId}". resolve only reads keys the provider owns.`,
      );
    }
    const value = this.#readEnv(keyName);
    this.#log({ ts: nowIso(), action: "resolve", providerId, keyName, found: value !== undefined });
    return value;
  }

  async proxyCall(req: ProxyRequest): Promise<ProxyResponse> {
    const provider = this.#registry.get(req.providerId);

    // #4 hardening: a live secret must NEVER ride in a URL query string (CWE-598 -- query strings
    // leak to server/proxy access logs, Referer headers and browser history, and fall outside the
    // DPoP binding). Secrets are injected via request HEADERS only; a query authInject is refused.
    if (req.authInject?.query !== undefined) {
      throw new Error(
        "credentials: refusing to inject a secret into a query parameter -- secrets in URLs leak " +
          "to logs/Referer/history (CWE-598). Use authInject.header instead.",
      );
    }

    // #4 DESTINATION BINDING: a resolved secret may only be injected into a call whose URL is within
    // the provider's registered base. Enforced HERE, before the secret is read -- an off-base URL
    // throws, so the secret is never loaded/injected/sent. Fires only when a header authInject is
    // present; an unauthenticated proxy call is a plain fetch (no secret to leak).
    const injectsSecret = req.authInject?.header !== undefined;
    if (injectsSecret) this.#assertUrlWithinBase(provider, req.url);

    const keyName = provider?.keyNames[0];
    const secret = injectsSecret && keyName ? this.#readEnv(keyName) : undefined;

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    // OPT-IN: bind this request to the agent key. The secret goes in a header (never the query) and
    // `htu` inside the proof strips any query, so the secret can never enter the proof.
    if (this.#dpopSigner) headers["DPoP"] = this.#dpopSigner.proof({ htm: req.method, htu: req.url });
    const url = req.url;
    const headerName = req.authInject?.header;
    if (secret && headerName) headers[headerName] = secret;

    let body: string | undefined;
    if (typeof req.body === "string") {
      body = req.body;
    } else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
    }

    // #4 REDIRECT hardening: when a secret rides in a request HEADER, do NOT auto-follow redirects.
    // The Fetch standard strips only `Authorization` across an origin change -- a custom secret
    // header (X-Api-Key, X-Api-Token, ...) would otherwise ride a `302 Location: https://evil` to
    // an UNVALIDATED host, leaking the key. In manual mode fetch returns the 3xx as-is and we hand
    // it back to the caller WITHOUT following it, so the injected secret only ever reaches the
    // in-base URL that #assertUrlWithinBase already validated. Unauthenticated calls keep the
    // default (follow) behavior -> the offline `mstack demo` path is byte-for-byte unchanged.
    const init: RequestInit = { method: req.method, headers, body };
    if (injectsSecret) init.redirect = "manual";
    const res = await this.#fetchImpl(url, init);

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    const resBody = await res.text();

    // The secret is only ever a header (never the query), so req.url is safe to log; headers,
    // which carry the secret, are never logged.
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
