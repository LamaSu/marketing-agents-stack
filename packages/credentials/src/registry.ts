/**
 * ProviderRegistry -- which providers exist, which env var(s) hold their credential, and
 * (optionally) a stable API base URL. Brokers consult this to know WHICH key to resolve for
 * a given `providerId`; adapters never consult the registry directly (they only ever see a
 * `ProviderProxy.proxyCall`, per this package's boundary -- see util.ts `forProvider`).
 */

export interface ProviderConfig {
  readonly providerId: string;
  /** env var name(s) that hold this provider's credential, in priority order. First present wins. */
  readonly keyNames: readonly string[];
  /** stable API base URL, when the provider has one (omit for per-org endpoints like Salesforce). */
  readonly baseUrl?: string;
  /**
   * env var holding a PER-ORG base URL, for providers whose endpoint is not static (e.g.
   * Salesforce's SALESFORCE_INSTANCE_URL). When a broker injects a secret it binds the outbound
   * URL to `baseUrl` if set, otherwise to the resolved value of `baseUrlEnv` (finding #4). If
   * neither resolves, the destination cannot be validated and the secret is refused -- so a
   * secret-injecting provider MUST have one of the two.
   */
  readonly baseUrlEnv?: string;
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderConfig>();

  register(config: ProviderConfig): void {
    this.#providers.set(config.providerId, config);
  }

  get(providerId: string): ProviderConfig | undefined {
    return this.#providers.get(providerId);
  }

  list(): ProviderConfig[] {
    return [...this.#providers.values()];
  }
}

/**
 * True iff `url` is "within" `base`: identical scheme + host (including port), and `base`'s path
 * is a segment-aligned prefix of `url`'s path. This is the destination bind a broker applies
 * BEFORE injecting a provider secret (finding #4) -- a scoped proxy must not be steerable to an
 * off-registered host. Fails CLOSED (returns false) on any unparseable input.
 *
 * Comparison is via WHATWG `URL`, so host is lowercased and a default port (80/443) is normalized
 * away on BOTH sides: `https://h` and `https://h:443` match; `https://h:8443` does not. A base at
 * the host root (e.g. `https://app.posthog.com`) admits any path on that host; a base carrying a
 * path (e.g. `https://api.example.com/v2`) admits only `/v2` and `/v2/...` (never `/v2evil`).
 */
export function isUrlWithinBase(url: string, base: string): boolean {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return false;
  }
  if (u.protocol !== b.protocol) return false;
  if (u.host !== b.host) return false;
  const basePath = b.pathname.replace(/\/+$/, "");
  if (basePath === "") return true;
  return u.pathname === basePath || u.pathname.startsWith(`${basePath}/`);
}

/**
 * Sample registrations matching the optional-connector keys in .env.example. Wave-2 adapters
 * (adapters-signals / adapters-enrichment / runtime) register real providers the same way.
 */
export const SAMPLE_PROVIDERS: readonly ProviderConfig[] = [
  { providerId: "posthog", keyNames: ["POSTHOG_API_KEY"], baseUrl: "https://app.posthog.com" },
  // Salesforce's base URL is per-org, so it binds to the SALESFORCE_INSTANCE_URL env var
  // (`baseUrlEnv`) instead of a static `baseUrl` -- the broker still refuses to inject the
  // token into a URL outside that resolved instance host (finding #4).
  { providerId: "salesforce", keyNames: ["SALESFORCE_ACCESS_TOKEN"], baseUrlEnv: "SALESFORCE_INSTANCE_URL" },
  { providerId: "resend", keyNames: ["RESEND_API_KEY"], baseUrl: "https://api.resend.com" },
];

export function defaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const config of SAMPLE_PROVIDERS) registry.register(config);
  return registry;
}
