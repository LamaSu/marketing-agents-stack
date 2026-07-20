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

## Known simplification

`authInject` sets the target header/query param to the raw resolved secret verbatim (no
`"Bearer "` templating). Real Wave-2 adapters that need `Authorization: Bearer <token>`
either pre-format at the env-var level or this package grows a `format` option when the
first real adapter needs it -- not added speculatively here.
