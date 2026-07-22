/**
 * openBroker() -- picks GatecraftBroker when a real MCP transport (`gcInvoke`) is supplied,
 * else falls back to the offline LocalBroker. See research/06-architecture.md §5.1: gatecraft
 * is opt-in, LocalBroker (env-var backed) is the default so the stack still runs with zero
 * network / zero credentials.
 */
import { type CredentialBroker, type LogSink } from "./types.js";
import { type DpopSigner } from "./dpop.js";
import { ProviderRegistry } from "./registry.js";
import { LocalBroker } from "./local-broker.js";
import { GatecraftBroker, type GcInvoke } from "./gatecraft-broker.js";

export interface OpenBrokerOptions {
  /** supply this to opt into gatecraft; the runtime layer wires the real MCP transport (see gatecraft-broker.ts). */
  gcInvoke?: GcInvoke;
  registry?: ProviderRegistry;
  log?: LogSink;
  /** LocalBroker only; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** LocalBroker only; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** OPT-IN DPoP request-binding (RFC 9449). Omit and both brokers behave exactly as before. */
  dpopSigner?: DpopSigner;
}

// NOTE (Infisical Agent Vault, verified 2026-07-22): SOTA-08 asked whether to align to
// Infisical's Agent Vault (an OSS HTTP credential proxy for agents -- this seam, productized).
// Verified live: Agent Vault is EE-gated (paid) -- its proxy machinery (`agent-proxy-ca`,
// `gateway*`) lives under `backend/src/ee/services`, and Infisical's README scopes the MIT
// license to everything EXCEPT `ee/` ("premium enterprise features requiring a Infisical
// license"). So there is intentionally NO `InfisicalBroker` branch here: it could not be a
// free/self-hostable default. If Infisical later moves the agent proxy into the MIT core, an
// `InfisicalBroker implements CredentialBroker` drops in exactly like GatecraftBroker below.
// The hardening we DID ship is DPoP request-binding (dpop.ts), which we own outright.
export function openBroker(options: OpenBrokerOptions = {}): CredentialBroker {
  if (options.gcInvoke) {
    return new GatecraftBroker(options.gcInvoke, {
      registry: options.registry,
      log: options.log,
      dpopSigner: options.dpopSigner,
    });
  }
  return new LocalBroker({
    registry: options.registry,
    log: options.log,
    env: options.env,
    fetchImpl: options.fetchImpl,
    dpopSigner: options.dpopSigner,
  });
}
