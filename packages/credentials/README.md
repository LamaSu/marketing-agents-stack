# @mstack/credentials

The credential-broker boundary: provider keys never enter agent or adapter context (see
`research/06-architecture.md` §3.3 + §5.1). `CredentialBroker` exposes `resolve()` (returns
the raw secret -- a trusted, low-volume diagnostic path only, e.g. startup health checks)
and `proxyCall()` (resolves the credential, injects it into an outbound HTTP call, and
returns only the response -- the secret never comes back). Provider/adapter code never gets
a full `CredentialBroker`; it gets a `ProviderProxy` via `forProvider(broker, providerId)`,
which exposes `proxyCall` only -- `resolve` is structurally absent from that object, not
just discouraged by convention (enforced + tested in `src/index.test.ts`).

Two implementations, picked by `openBroker()`:

- **`LocalBroker`** (default, offline) -- resolves keys from env vars in exactly one place
  inside the class (`#readEnv`). Logs every resolve/proxy call (`providerId` + `keyName` +
  timestamp, never the value) to an injectable sink (defaults to `console`).
- **`GatecraftBroker`** (opt-in) -- maps the same interface onto gatecraft's `gc_proxy_call`
  / `gc_acquire_credential` MCP tools via an injected `GcInvoke` transport, because a plain
  npm package cannot call an MCP tool directly. The real transport is wired by the runtime
  layer (`packages/runtime`), not this package -- see the header comment in
  `src/gatecraft-broker.ts` for the wiring example. `openBroker()` falls back to
  `LocalBroker` whenever no `gcInvoke` is supplied.

## Example

```ts
import { openBroker, forProvider } from "@mstack/credentials";

const broker = openBroker(); // LocalBroker by default (offline, env-var backed)
const posthog = forProvider(broker, "posthog"); // proxyCall only -- no resolve

const res = await posthog.proxyCall({
  method: "GET",
  url: "https://app.posthog.com/api/projects",
  authInject: { header: "Authorization" },
});
```

## Sample provider registrations

`posthog`, `salesforce`, `resend` -- matching the optional connector keys already declared
in `.env.example`. Register more with `registry.register({ providerId, keyNames, baseUrl? })`.

## Request-binding with DPoP (RFC 9449) -- opt-in

`src/dpop.ts` adds **Demonstrating Proof-of-Possession** (RFC 9449) as an opt-in hardening
for either broker. When a `dpopSigner` is configured, each `proxyCall` attaches a `DPoP`
proof header -- a short-lived JWT, signed by the agent's own key, that binds the request to
its HTTP method (`htm`), URL (`htu`), issue time (`iat`), and a unique `jti`. A proof
captured off the wire cannot be replayed against a different method/URL, and expires within
seconds-to-minutes (`maxAgeSeconds`, default 300).

Why it fits the boundary this package exists to enforce:

- **The private key never leaves the process.** `createDpopSigner(keyPair)` holds the key in
  a closure and returns only `proof()`, `publicJwk`, and the RFC 7638 thumbprint `jkt`. The
  DPoP key is a *request-binding identity*, not a provider secret -- it does not weaken
  "agent never sees the key".
- **A query-injected secret can never enter a proof.** `htu` is normalized to strip the
  query string (RFC 9449 §4.2), so `LocalBroker`'s `authInject.query` secret stays off the
  proof entirely (proven in `src/dpop.test.ts`).
- **Off by default.** No `dpopSigner` -> not a single byte changes; the keyless offline
  `mstack demo` path is untouched. ES256 (ECDSA P-256) and EdDSA (Ed25519) are supported via
  `node:crypto` only -- no new dependency.

```ts
import { openBroker, forProvider, generateDpopKeyPair, createDpopSigner } from "@mstack/credentials";

const dpopSigner = createDpopSigner(generateDpopKeyPair("ES256")); // or inject an existing key
const broker = openBroker({ dpopSigner });                          // still LocalBroker (offline) by default
const posthog = forProvider(broker, "posthog");
// every posthog.proxyCall(...) now carries a DPoP proof bound to that exact (method, url)
```

`verifyDpopProof(proof, { htm, htu, now?, maxAgeSeconds?, clockSkewSeconds?, nonce?, isReplay? })`
is provided for a resource/proxy server to validate proofs (checks signature -> `htm`/`htu`
binding -> freshness -> optional nonce/replay), returning the bound-key `jkt` on success.

## Infisical Agent Vault -- verified EE-gated (2026-07-22), so NOT adopted

SOTA-08 flagged that Infisical shipped **Agent Vault** (April 2026) -- an open-source HTTP
credential proxy for agents, i.e. this package's exact pattern, productized -- and asked
whether it lives in the MIT core or the proprietary `ee/` tier. **Verified live: it is
`ee/`-gated (paid).** Infisical's README states the repo is MIT "with the exception of the
`ee` directory which will contain premium enterprise features requiring a Infisical
license," and Agent Vault's proxy machinery (`agent-proxy-ca`, alongside `gateway`/
`gateway-v2`/`gateway-pool`) sits under `backend/src/ee/services`. Because it is not
free/self-hostable, an `InfisicalBroker` would not be a usable *default*, so it was **not
built** -- we ship the DPoP hardening (which we own outright) instead. The `CredentialBroker`
seam + `openBroker()` selection make an `InfisicalBroker implements CredentialBroker` a
drop-in for a future wave *if* Infisical moves the agent proxy into the MIT core.

## Known simplification

`authInject` sets the target header/query param to the raw resolved secret verbatim (no
`"Bearer "` templating). Real Wave-2 adapters that need `Authorization: Bearer <token>`
either pre-format at the env-var level or this package grows a `format` option when the
first real adapter needs it -- not added speculatively here.
