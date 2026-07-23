/**
 * The credential-broker seam contract. See research/06-architecture.md §3.3 + §5.1:
 * "All keys are brokered by gatecraft ... providers never read process.env; the broker
 * injects at call time and logs the call." `packages/credentials` is that boundary made
 * physical -- a package boundary you can audit in one place (§3.2 rationale).
 *
 * Two ways in:
 *  - `resolve()` returns the raw secret string. TRUSTED, low-volume, diagnostic use only
 *    (health checks, startup validation). Never call this from provider/adapter code.
 *  - `proxyCall()` resolves the credential, injects it into the outbound call, and returns
 *    only the HTTP response -- the secret never leaves the broker. This is the seam
 *    provider/adapter code actually uses, always through a scoped `ProviderProxy` (see
 *    `forProvider()` in util.ts), which exposes `proxyCall` only. `resolve` is not
 *    reachable from a `ProviderProxy` -- this is the KEY INVARIANT, enforced structurally
 *    (not just by convention -- see util.ts + index.test.ts).
 */

export interface CredentialBroker {
  readonly name: string;
  resolve(providerId: string, keyName: string): Promise<string | undefined>;
  proxyCall(req: ProxyRequest): Promise<ProxyResponse>;
}

/** Where to inject the resolved secret into the outbound call. Omit both to call unauthenticated. */
export interface AuthInject {
  /** request header to set to the resolved secret, e.g. "Authorization" or "X-API-Key". */
  header?: string;
  /**
   * @deprecated Refused at runtime (finding #4). A secret must never ride in a URL query string
   * (CWE-598 -- it leaks to server/proxy access logs, Referer headers and browser history, and
   * falls outside the DPoP binding). Use `header` instead; a broker throws on a query authInject.
   */
  query?: string;
}

export interface ProxyRequest {
  providerId: string;
  method: string; // "GET" | "POST" | ...
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  /** which credential to inject and where; defaults to the provider's first registered keyName. */
  authInject?: AuthInject;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The narrow handle a PROVIDER implementation (e.g. a future `EnrichmentProvider`) actually
 * receives -- `proxyCall` bound to one `providerId`, nothing else. No `resolve`. This is
 * what the build task's "KEY INVARIANT" refers to: a provider object cannot read the raw
 * secret, it can only ask the broker to make an authed call on its behalf.
 */
export interface ProviderProxy {
  readonly providerId: string;
  proxyCall(req: Omit<ProxyRequest, "providerId">): Promise<ProxyResponse>;
}

/**
 * One audited line per resolve/proxy call. NEVER add a field carrying the secret value --
 * this type IS the schema for what's allowed to be logged (telemetry only).
 */
export interface BrokerLogEntry {
  ts: string;
  action: "resolve" | "proxyCall";
  providerId: string;
  keyName?: string;
  found?: boolean;
  method?: string;
  url?: string;
  status?: number;
}

export type LogSink = (entry: BrokerLogEntry) => void;
