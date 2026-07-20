/** Small shared helpers for the credentials package (default log sink, provider scoping). */
import { type CredentialBroker, type ProviderProxy, type BrokerLogEntry, type LogSink } from "./types.js";

/** Default log sink: one JSON line to console. Never pass the secret value into an entry. */
export const consoleLogSink: LogSink = (entry: BrokerLogEntry) => {
  console.log(`[credentials] ${JSON.stringify(entry)}`);
};

/**
 * Scope a broker down to the `ProviderProxy` a provider implementation should hold: only
 * `proxyCall`, bound to one `providerId`. The returned object literal closes over
 * `broker.proxyCall` alone -- `broker.resolve` is never captured, so it is structurally
 * absent from the result, not merely hidden by convention. This is the mechanical
 * enforcement of the KEY INVARIANT ("a provider object must NOT be able to read the raw
 * secret -- it only gets a proxyCall"); see the reflection-based test in index.test.ts.
 */
export function forProvider(broker: CredentialBroker, providerId: string): ProviderProxy {
  return {
    providerId,
    proxyCall: (req) => broker.proxyCall({ ...req, providerId }),
  };
}
