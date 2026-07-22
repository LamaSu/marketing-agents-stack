# @mstack/adapters-crm

Push OUR derived scores/decisions/outcomes back INTO a CRM (Salesforce,
HubSpot, …) — the write-back half of the loop paid tools like MadKudu /
ZoomInfo charge for. Enrichment + scoring is only half the value; **writing
the score onto the Account/Lead record in the CRM the sales team already
lives in is the actual delivery mechanism.** Closing that gap is this
package's whole job.

Design mirrors `adapters-enrichment/src/crawl4ai.ts` (injectable-fetch,
degrade-safe sidecar) and `adapters-outreach/src/composio-channel.ts`
(lazy-import structural Composio client).

## The seam

```ts
interface CrmSync {
  readonly name: string;
  pushScore(account: Account): Promise<void>;
  pushDecision(decision: Decision): Promise<void>;
  pushOutcome(outcome: Outcome): Promise<void>;
}
```

Package-local — **not** one of `@mstack/core`'s five shared adapter seams
(see `src/crm-sync.ts`'s file header for why). And **no Approval gate**
(unlike `OutreachChannel`): this pushes already-computed DERIVED signal onto
our own account's CRM record, not new customer-facing content — see that
same header for the guardrail-#2 boundary and where a future CRM-triggered
customer send would have to go instead (back through `OutreachChannel` +
`Approval`, never through this seam).

## Offline-first

`noopCrmSync` is the default: every method resolves immediately, touches no
network, logs nothing. This is what `mstack demo` and every keyless path
uses. Nothing in this package sits on the offline critical path until a
deployer explicitly opts in to one of the real implementations below.

## Usage

### HTTP (your own middleware / proxy in front of Salesforce or HubSpot)

```ts
import { createHttpCrmSync } from "@mstack/adapters-crm";

const crm = createHttpCrmSync({
  baseUrl: "https://your-crm-proxy.internal", // REQUIRED, explicit — no default
  apiKey: process.env.CRM_PROXY_KEY!,          // REQUIRED, explicit — never auto-read here
});

await crm.pushScore(account);     // POST {baseUrl}/accounts/{domain}/score
await crm.pushDecision(decision); // POST {baseUrl}/decisions
await crm.pushOutcome(outcome);   // POST {baseUrl}/outcomes
```

A CRM outage, bad config, or non-2xx response **never throws** — it logs a
secret-redacted warning and resolves, so a CRM being down can never break the
scoring/decision loop that produced the data in the first place.

Some CRM integrations authenticate via a query parameter instead of a header
(e.g. HubSpot's older `hapikey` pattern):

```ts
createHttpCrmSync({ baseUrl, apiKey, authStyle: "query", queryParamName: "hapikey" });
```

The key is redacted from every log line even in this mode — see
`src/http-crm-sync.ts`'s `redactSecret`.

### Composio (route through HubSpot/Salesforce actions)

```ts
import { createComposioCrmSync } from "@mstack/adapters-crm";

const crm = await createComposioCrmSync({
  apiKey: process.env.COMPOSIO_API_KEY!,
  connectedAccountId: "ca_...", // a Composio connected account you established
  actions: {
    score: {
      action: "HUBSPOT_UPDATE_CONTACT",
      mapArgs: (a) => ({ domain: a.domain, mstack_score: a.score, mstack_tier: a.tier }),
    },
    decision: {
      action: "SALESFORCE_UPDATE_RECORD",
      mapArgs: (d) => ({ objectType: "Lead", fields: { Rationale__c: d.rationale } }),
    },
    // `outcome` omitted here -- that push type silently no-ops, same
    // "never breaks the caller" contract as everything else in this package.
  },
});
```

The SDK is loaded lazily (a dynamic `import` inside `createComposioCrmSync`)
— importing this package never drags `@composio/core` into the offline
graph. Omit any of `score` / `decision` / `outcome` to no-op that push type.

For tests, construct `new ComposioCrmSync(fakeClient, { actions })` directly
— no SDK, no network.

## Degrade-safe by construction

Every real implementation in this package (`httpCrmSync`, `composioCrmSync`)
**never throws**. A push failure — network error, timeout, non-2xx, a
Composio action failure — logs one `console.warn` and resolves. `noopCrmSync`
sets the floor: doing nothing is always a valid, safe outcome. This mirrors
`crawl4aiFetchSite`'s "degraded, never broken" contract exactly, and means a
`CrmSync` can be wired into a live pipeline with zero risk of it becoming a
new failure mode for the rest of the loop.

## Assumption to verify on a real install

Written without `pnpm install` (see `docs/build-conventions.md`). The
`@composio/core` v0.14 execute surface adapted in `createComposioCrmSync` is
assumed to be `new Composio({ apiKey }).tools.execute(slug, { arguments,
userId?, connectedAccountId? })` → `{ data, error, successful }` — the same
assumption `adapters-outreach/src/composio-channel.ts` makes. If a live
install differs, fix the adapter in `createComposioCrmSync` only — the
`ComposioCrmSync` class, `ComposioLike`, and every test are unaffected.
