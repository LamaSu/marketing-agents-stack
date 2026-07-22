# @mstack/adapters-outreach

Composio behind the `OutreachChannel` seam — the account-intel / GTM swarm's
send reach (1000+ app actions: Gmail, Slack, Outreach, HubSpot, …) **without**
opening a second, ungated send path.

Design: `research/10-sota-integration-design.md` §2.3 (Wave C1).

## The one guarantee

A `ComposioChannel` can send **only** the way every channel sends: by being
handed a matching, `approve`d, hash-chained `Approval`. `dispatch(draft,
approval)` re-asserts that invariant (`assertApproved`) **before** it ever calls
Composio — and in the running system, the only caller of any channel's
`dispatch` is `@mstack/runtime`'s single gated `dispatchDraft`, which re-derives
everything from the system of record first. Guardrail #2 ("a human approves
every send") is a **type on the seam**; Composio's reach cannot bypass it.

## Offline-first

Nothing here is on the keyless `mstack demo` path. The `ComposioChannel` class
is pure dependency-injection over a tiny `ComposioLike` interface (fully
offline-testable with a fake). The real `@composio/core` SDK is loaded **lazily**
(a dynamic `import` inside `createComposioChannel`), so importing this package
never drags the SDK into the offline graph.

## Usage

```ts
// Opt-in, keyed. Loads the SDK lazily.
import { createComposioChannel } from "@mstack/adapters-outreach";

const channel = await createComposioChannel({
  apiKey: process.env.COMPOSIO_API_KEY!, // supply explicitly; never auto-read here
  action: "GMAIL_SEND_EMAIL",
  connectedAccountId: "ca_...",          // a Composio connected account you established
  mapDraft: (d) => ({ recipient: d.refId, subject: d.subject, body: d.body }),
});

// Then hand it to the runtime — dispatch still flows through the gated
// dispatchDraft, which supplies the approved, persisted Approval.
```

For tests, construct `new ComposioChannel(fakeClient, { action })` directly — no
SDK, no network.

## Live-verified notes (2026-07-21)

- **Package: `@composio/core`** (0.14.0). The older `composio-core` (0.5.x) is
  **npm-deprecated** ("no longer supported") — don't use it. `@composio/slim` is
  a smaller same-API variant.
- **License:** MIT at the repo `LICENSE` (ComposioHQ/composio); the published
  `@composio/core` package.json declares **ISC**. Both permissive, no copyleft —
  but an automated SPDX checker reads "ISC". Do a manual license-checker pass
  before shipping a vendored build.
- **Auth:** Composio-managed OAuth `initiate()` has been returning 400 for all
  orgs since **2026-07-03**. Use Hosted Auth (Connect Link /
  `connectedAccounts.link()`) or non-OAuth (API-key/bearer) schemes. This channel
  is auth-agnostic — it takes an already-resolved `connectedAccountId`.
- **Credential tension (documented, not solved here):** the SDK constructor
  needs a raw API key, which is in tension with "creds never in agent context".
  The Infisical/DPoP resolution is Wave D2 (§2.10). Until then, run this behind a
  deployer-controlled boundary.

## Assumption to verify on a real install

Written without `pnpm install` (see `docs/build-conventions.md`). The
`@composio/core` v0.14 execute surface adapted in `createComposioChannel` is
assumed to be `new Composio({ apiKey }).tools.execute(slug, { arguments, userId?,
connectedAccountId? })` → `{ data, error, successful }`. If a live install
differs, fix the adapter in `createComposioChannel` **only** — the channel class,
`ComposioLike`, and every test are unaffected.
