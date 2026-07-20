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
 * Sample registrations matching the optional-connector keys in .env.example. Wave-2 adapters
 * (adapters-signals / adapters-enrichment / runtime) register real providers the same way.
 */
export const SAMPLE_PROVIDERS: readonly ProviderConfig[] = [
  { providerId: "posthog", keyNames: ["POSTHOG_API_KEY"], baseUrl: "https://app.posthog.com" },
  // Salesforce's base URL is per-org (SALESFORCE_INSTANCE_URL), so callers pass the full
  // `url` on each ProxyRequest rather than relying on a static baseUrl here.
  { providerId: "salesforce", keyNames: ["SALESFORCE_ACCESS_TOKEN"] },
  { providerId: "resend", keyNames: ["RESEND_API_KEY"], baseUrl: "https://api.resend.com" },
];

export function defaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const config of SAMPLE_PROVIDERS) registry.register(config);
  return registry;
}
