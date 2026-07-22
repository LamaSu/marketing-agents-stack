# @mstack/adapters-outcomes

The **return leg** — `OutcomeSource` implementations behind a package-local seam
(`src/outcome-source.ts`, the structural analogue of `@mstack/core`'s `SignalSource`) that
turn reply/meeting/no-response engagement events into `Outcome` rows (`@mstack/core`'s
`schemas.ts`). `runtime/dispatch.ts` already writes the FORWARD leg (`result:"sent"`, at
send time); this package is what closes the loop on everything that happens AFTER a send —
a prospect replies, books a meeting, or never responds.

Every source returns `Outcome[]`, and `ingestOutcomes(source, memory)` persists a pull into
`@mstack/memory`'s `outcomes` table (the same table `runtime/dispatch.ts` already writes
`"sent"` rows into) — so once outcomes land in `memory`, they're queryable by anything that
already knows how to read it:

- **Sequences stop-on-reply** — a cadence/sequence runner can check `outcomes` for a
  `refId`'s latest `result` before sending the next step in an outreach sequence, and skip
  it on `"replied"`/`"meeting"`.
- **Qualifier training labels** — `adapters-scoring`'s `GaussianProcessQualifier` currently
  learns from `Approval` decisions (`approvalToLabel`); `Outcome` rows are a stronger,
  ground-truth signal for the same loop (a `"replied"`/`"meeting"` outcome is direct
  evidence of lead quality, not a proxy for it) for whoever wires that join next.
- **Analytics funnel** — `result` counts over time (`sent → replied → meeting`) are a
  straight `GROUP BY` over `memory.query()`, no new read path required.

This package only builds the ingestion seam + the offline demonstration data; it does not
modify the sequence runner, the qualifier, or the analytics view — those are separate,
out-of-scope consumers this seam is designed to unblock.

## Sources

- **`SampleOutcomeSource`** (default, offline) — reads this package's own bundled
  `data/outcomes.sample.jsonl` fixture (8 rows: four dispatched drafts followed by their
  reply/meeting/no_response return-leg outcomes). Zero network, zero credentials. Falls
  back to a tiny inline fixture if the real file can't be read, so it never throws.
- **`WebhookOutcomeSource`** (push, opt-in) — validates + maps a neutral `EngagementEvent`
  shape (`{ type, refId, refType?, id?, ts?, metrics? }`) with `zod`. Any ESP/CRM webhook
  route can translate its own payload into this shape and call `ingest()` — unlike Segment,
  there's no single industry-standard ESP webhook spec to piggyback on, so this is a small,
  neutral contract this package owns.
- **`HttpOutcomeSource`** (pull, opt-in) — polls a configured endpoint
  (`GET <endpoint>?since=&limit=`) via an injectable `fetch`, mirroring
  `adapters-enrichment`'s `crawl4aiFetchSite` degrade pattern: on ANY failure (unreachable,
  non-OK, timeout, malformed response) it logs a warning and resolves to `[]` (or an
  injectable `fallback` `OutcomeSource`) instead of throwing — an ingestion poll must never
  crash a scheduled job because one third-party endpoint call failed.

`WebhookOutcomeSource` and `HttpOutcomeSource` share one mapping table
(`outcomeFromEngagementEvent` / `ENGAGEMENT_TYPE_MAP` in `webhook-outcome-source.ts`), so
both agree on engagement-type vocabulary by construction: `replied`/`reply`/`email_replied`
→ `"replied"`; `meeting`/`meeting_booked`/`meeting_scheduled` → `"meeting"`;
`bounced`/`bounce`/`unsubscribed`/`no_response`/`none` → `"no_response"`; plus direct
pass-through for `sent`/`published`/`returned` (the other three `OutcomeResult` values) for
a producer that already speaks our vocabulary. An unrecognized `type` throws a clear error
rather than silently guessing.

## Usage

```ts
import { SampleOutcomeSource, ingestOutcomes } from "@mstack/adapters-outcomes";
import { openMemory } from "@mstack/memory";

const memory = await openMemory();
const sample = new SampleOutcomeSource();
const result = await ingestOutcomes(sample, memory); // { pulled, ingested, skippedDuplicateIds }
```

```ts
// WebhookOutcomeSource -- wire into an ESP/CRM webhook route (framework-agnostic)
import { outcomeSource } from "@mstack/adapters-outcomes";

const webhook = outcomeSource("webhook");
app.post("/webhooks/esp", (req, res) => {
  webhook.ingest(req.body); // after your route maps the provider's payload to EngagementEvent shape
  res.sendStatus(200);
});
// elsewhere, on a schedule: await ingestOutcomes(webhook, memory) drains + persists the buffer.
```

```ts
// HttpOutcomeSource -- poll a CRM's engagement-events endpoint on a schedule
const http = outcomeSource("http", { endpoint: "https://api.example-crm.com/v1/engagement-events" });
await ingestOutcomes(http, memory, { since: lastPollIso });
```

## Config

- `SampleOutcomeSource`: `dataDir` (ctor) > `OUTCOME_SAMPLE_DATA_DIR` env > this package's
  own `data/` dir, resolved relative to this package's own file location — works from
  `src/` or compiled `dist/`, any cwd. Deliberately a package-local fixture (not the shared
  repo-root `data/` package) so this package stays independently installable and
  change-isolated from `@mstack/data`'s own fixture-validation test.
- `HttpOutcomeSource`: `endpoint` is required config (no sensible zero-config default for an
  arbitrary third-party ESP/CRM). `headers`/credentials are constructor config, never read
  from `process.env` by this package itself — same convention as `PostHogSource`/
  `GitHubSignalSource` in `adapters-signals`.
- Every network-touching source takes an injectable `fetchImpl` so tests never hit the
  network — see `src/*.test.ts`.

## Offline-first

`SampleOutcomeSource` needs no network or credentials, and `ingestOutcomes` against a
`MemoryRepo` is fully in-process — this package's whole test suite runs offline, matching
`docs/build-conventions.md`'s "write correct code + tests; do not install or run the build
locally" contract (types reasoned from `@mstack/core`/`@mstack/memory` source; the
consolidated `pnpm install && pnpm -r build && pnpm -r test` runs on Spark).

## API assumptions to confirm on Spark

Written per `docs/build-conventions.md` (no local `pnpm install`/`pnpm test`):

- There is no canonical "ESP/CRM outcomes webhook/API" spec the way there is for Segment's
  HTTP Tracking spec (used by `adapters-signals`' `SegmentWebhookSource`) — `EngagementEvent`
  and `HttpOutcomeSource`'s `GET <endpoint>?since=&limit=` + `{ events: [...] }` response
  shape are this package's own reasoned design choice, not a live-verified third-party
  contract. A real integration's webhook route handler / polling adapter should translate
  its provider's native payload into this shape before calling `ingest()`, or call this
  package's `outcomeFromEngagementEvent` mapper directly.
- `@duckdb/node-api` assumptions used by this package's `ingest.test.ts` (via `openMemory`)
  are `@mstack/memory`'s own, documented in that package's file header — not re-verified here.
