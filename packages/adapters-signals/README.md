# @mstack/adapters-signals

`SignalSource` implementations behind `@mstack/core`'s ingest seam (`research/06-architecture.md`
§5.1; design rationale in `research/tools/A-signals-ingestion.md`). Every source returns
`Signal[]` — the one normalized, Segment-spec-shaped event type the rest of the stack reasons
about — so swapping the offline fixture for a real source is a one-line registration change with
nothing downstream touched.

- **`SampleSource`** (default, offline) — reads the bundled `data/signals.sample.jsonl` fixture.
  Zero network, zero credentials. Falls back to a tiny inline fixture if the real file can't be
  read, so it never throws.
- **`SegmentWebhookSource`** (push) — validates + maps the Segment HTTP Tracking spec
  (`identify`/`track`/`page`/`group`, `batch` supported) with `zod`. Any Segment-spec producer
  (Jitsu, RudderStack, Segment, OpenSnowcat) can POST into whatever route wraps `ingest()`.
- **`PostHogSource`** (pull, opt-in) — the product-usage connector, over PostHog's REST Events
  API via an injectable `fetch`. Hardened with opt-in pagination (follow `next` cursor) and
  bounded exponential backoff on HTTP 429 rate-limit responses.
- **`GitHubSignalSource`** (pull, opt-in) — public "developer intent" signals (repo stats
  snapshot + recent issues) via an injectable `@octokit/rest` client.
- **`SqlWarehouseSource`** (pull, opt-in) — bring-your-own-warehouse, over an injected
  `query(sql, params)` function shaped like `@mstack/memory`'s `MemoryRepo.query`.

## Usage

```ts
import { SampleSource, signalSource } from "@mstack/adapters-signals";

const sample = new SampleSource();
const signals = await sample.pull(); // Signal[], zero network/creds -- what mstack seed/demo use

const posthog = signalSource("posthog", {
  projectId: "12345",
  apiKey: process.env.POSTHOG_API_KEY,
  enablePagination: true, // follow PostHog's `next` cursor across pages
  maxRateLimitRetries: 3, // bounded exponential backoff on HTTP 429
});
const recent = await posthog.pull({ since: "2026-07-01T00:00:00.000Z", limit: 50 });
```

```ts
// SegmentWebhookSource -- wire into an HTTP route (framework-agnostic)
const segment = new SegmentWebhookSource();
app.post("/webhooks/segment", (req, res) => {
  segment.ingest(req.body); // validates + maps + buffers
  res.sendStatus(200);
});
// elsewhere: await segment.pull() drains whatever ingest() has buffered so far.
```

```ts
// SqlWarehouseSource paired with @mstack/memory's own query() escape hatch
const memory = await openMemory();
const warehouse = new SqlWarehouseSource({ query: memory.query.bind(memory) });
const signals = await warehouse.pull({ since: "2026-06-01T00:00:00.000Z" });
```

## Config

- `SampleSource`: `dataDir` (ctor) > `SAMPLE_DATA_DIR` env > repo-root `data/`, resolved relative
  to this package's own file location — works from `src/` or compiled `dist/`, any cwd.
- `PostHogSource` / `GitHubSignalSource`: `apiKey`/`token` are constructor config, never read
  from `process.env` by this package itself — the runtime layer threads `.env.example`'s
  `POSTHOG_API_KEY` (or brokers it via `@mstack/credentials`/gatecraft, `research/06-architecture.md`
  §5.1) through at registration time.
- Every network-touching source takes an injectable client (`fetchImpl` / `octokit` / `query`) so
  tests never hit the network — see `src/*.test.ts`.

## Known gaps (design per research/10-sota-integration-design.md §2.4)

This package intentionally stays thin and delegates two critical concerns *upstream* to the CDP/warehouse tier:

1. **No collection tier** — this package pulls signals from PostHog, a warehouse, or a webhook, but does NOT capture them. A user
   with zero event infrastructure must first stand up an upstream event collection layer. Recommended options (all MIT, self-hostable):
   - **Jitsu** (MIT, server) — POST-based event collection that maps to the Segment spec. Plug into `SegmentWebhookSource`
     directly with zero new code.
   - **PostHog** (MIT, self-hosted) — product-usage snapshots, pulled via `PostHogSource`.
   - **OpenSnowcat** (Apache-2.0, server) — lightweight event collection compatible with Segment spec.

2. **No identity resolution** — events arrive with `distinct_id` / `userId` fields. Matching users across sources (e.g.,
   "did GitHub user 'alice' open the same PR as PostHog user 'alice@company.com'?") is the upstream CDP's job — this package
   preserves whatever identity the source provides. If a CDP offers identity resolution, its unified output (a single user key)
   lands in `actor.userId` and can be used for signal joining downstream. The `Signal` type has no merge/unification logic by
   design.

## API assumptions to confirm on Spark

Written per `docs/build-conventions.md` (no local `pnpm install`/`pnpm test`). Reasoned choices,
not verified live calls:

- **`PostHogSource` pulls via PostHog's REST Events API through an injectable `fetch`, not the
  `posthog-node` SDK** — `posthog-node` is capture/write-oriented and has no confirmed stable
  method for reading events back. `posthog-node` stays a declared dependency (per the research
  file's verdict) for a future capture-side use, just not imported by this pull adapter. Confirm
  the `results[]` response shape and `after`/`before` params against a live project.
- **`GitHubSignalSource`** field names (`stargazers_count`, `pull_request` presence to filter PRs
  out of the issues list, `since` filtering by `updated_at`) are asserted from GitHub's public
  REST docs, not a live call. Per-star timestamped events are deliberately out of scope (needs
  the stargazers endpoint's special Accept header); the repo-stats snapshot covers "stars/
  watchers" instead.
- **Segment `type` → `Signal.kind`** (`identify`→`identify`, `track`→`product_usage`,
  `page`→`campaign`, `group`→`crm`) is this package's own design choice — the Segment spec has
  no notion of "kind". Chosen to match `data/signals.sample.jsonl`'s existing `source:"segment"`
  conventions; full reasoning in the comment above `signalFromSegmentEvent`.
- **`SqlWarehouseSource`'s default query is DuckDB/`@mstack/memory`-flavored** (`$since`/`$limit`
  named placeholders). A different warehouse/engine should pass `sql` + `mapRow` using whatever
  placeholder syntax its own injected `query` implementation expects.
- `posthog-node`/`@octokit/rest` version pins in `package.json` are best-effort ranges (no
  registry access during this build) — `pnpm install` on Spark resolves the real versions.
