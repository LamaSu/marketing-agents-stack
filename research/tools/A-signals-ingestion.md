# A — Signal / Intent Ingestion: Free & Open-Source Tools

> Research file for the OPEN "Marketing Agents in Production" stack.
> Layer: **SIGNAL / INTENT INGESTION** (Guan's "Unify Customer Signals": CRM +
> product usage + campaign engagement + web/3rd-party intent).
> Goal: a drop-in OSS alternative to closed SaaS (Common Room, Segment, Unify,
> ZoomInfo intent) that **runs offline with a bundled sample dataset** and
> **optionally connects real sources** through a clean TS adapter interface.
> Author: researcher agent · Date: 2026-07-20 · All licenses verified via GitHub API.

## Progress tracker
- [x] RudderStack · Jitsu · Snowplow · Grouparoo · PostHog
- [x] Open reverse-ETL (Multiwoven, Airbyte) · open intent sources
- [x] crowd.dev / LFX CDP (the OSS Common Room analog)
- [x] Segment HTTP spec + webhook/warehouse capture pattern
- [x] TS `SignalSource` adapter interface design
- [x] Final DEFAULT + verified packages to install

---

## RECOMMENDATION (lead)
**Do NOT adopt a heavyweight CDP for v1.** Every CDP-class tool has drifted to a
**source-available** license (RudderStack → Elastic License 2.0; Snowplow → SLULA)
or assumes a running warehouse + streaming infra — too heavy to bundle offline and
legally awkward to ship inside an open stack.

**Build a thin `SignalSource` adapter interface in our own TS runtime.** Ship a
**bundled JSONL sample dataset** as the default offline source, and provide thin
real adapters that speak **stable, permissively-licensed contracts**:

1. **Segment HTTP tracking spec** (`identify`/`track`/`page`/`group`) as our wire
   format — so Jitsu (MIT), RudderStack, or Segment itself can all POST into us
   with zero custom code. We target *the spec*, not any one product.
2. **PostHog (MIT)** read adapter — the product-usage signal, purpose-built.
3. **Public GitHub / HN / Reddit** pull adapters — the open, free replacement for
   the *ingestion* half of Common Room / ZoomInfo intent (the proprietary half is
   identity enrichment, which stays a pluggable commercial slot). If a user wants a
   turnkey OSS community-signal engine, point them at **LFX CDP (crowd.dev,
   Apache-2.0)**.

**Verified packages to install (all MIT):** `zod`, `posthog-node`, `@octokit/rest`.
Details + rationale in the final section.

---

## Tool-by-tool findings

### RudderStack — source-available CDP (Segment alternative) — SKIP-as-dep
- **What**: Warehouse-native CDP. Events via SDK/HTTP → transform → warehouse +
  200+ destinations. "Segment alternative for data engineers." Go + React.
- **License**: **Elastic License 2.0 (ELv2)** on `rudder-server` + self-hosted
  project — **source-available, NOT OSI open source** (bars managed-service resale).
  Earlier AGPL-3.0 core + MIT SDKs. SDKs/many integrations still permissive.
- **Self-hostable?**: Yes (Docker/Helm), same core Community + Enterprise; wants
  Postgres + a warehouse; operationally non-trivial.
- **Maturity**: High — v1.0, 170+ contributors, widely deployed, active.
- **Plug-in**: SDKs/HTTP speak the **Segment spec**; a RudderStack "webhook"
  destination → our adapter parses Segment-shaped JSON. We target the spec.
- **Verdict**: **SKIP as a bundled dependency** (ELv2 + heavy). **EXTEND-compatible**
  — accept its Segment-shaped webhook as one real connector.
- Src: https://github.com/rudderlabs/rudder-server ·
  https://www.rudderstack.com/blog/rudderstacks-licensing-explained/

### Jitsu — MIT event ingestion (Segment alternative) — ADOPT-as-optional
- **What**: OSS, fully-scriptable event ingestion. Events (JS SDK / HTTP) →
  lightweight JS transforms → warehouses (Snowflake/BigQuery/Redshift/Postgres/
  MySQL/ClickHouse). Jitsu 2.0 current.
- **License**: **MIT** — genuinely OSI open source. Key differentiator vs
  RudderStack/Snowplow.
- **Self-hostable?**: Yes — Docker Compose. Cloud free to 200k events/mo w/ bundled
  ClickHouse.
- **Maturity**: Medium-high; active, Segment-compatible SDKs; smaller community.
- **Plug-in**: (a) run Jitsu, use Segment-compatible ingestion, forward to our
  webhook; or (b) adopt its **Segment-compatible event shape** as our wire format.
- **Verdict**: **ADOPT as the recommended optional real connector.** Best-licensed
  CDP-class tool; too heavy to *bundle* for offline v1, but the one to recommend for
  a full self-hosted pipeline.
- Src: https://github.com/jitsucom/jitsu · https://next.jitsu.com/features/segment-compatibility

### Snowplow — source-available behavioral platform — SKIP (OpenSnowcat = escape hatch)
- **What**: Most mature behavioral pipeline. Strongly-typed self-describing-JSON
  events + Iglu schema registry; collector → enrich → warehouse. Gold standard for
  event modeling.
- **License**: **SLULA** since Jan 2024 (v1.1 Dec 2024) — **source-available**;
  test/academic/non-production only, **production/commercial needs a paid license**.
  Was Apache-2.0.
- **Open fork**: **OpenSnowcat** — Apache-2.0 fork of pre-SLULA Snowplow, Snowplow +
  Segment SDK compatible (SnowcatCloud). The genuinely-open path.
- **Self-hostable?**: Snowplow — SLULA bars production self-host w/o license.
  OpenSnowcat — yes, Apache-2.0, unrestricted.
- **Maturity**: Very high (Snowplow); OpenSnowcat newer, tracks a mature base.
- **Verdict**: **SKIP for v1** (over-engineered for a marketing-signal demo; SLULA
  on the main line). Warehouse-read adapter if a user already runs it. Note
  OpenSnowcat as the Apache-2.0 escape hatch.
- Src: https://docs.snowplow.io/docs/resources/limited-use-license-faq/ ·
  https://www.snowcatcloud.com/snowplow/open-source/

### PostHog — MIT product analytics + CDP — ADOPT (first real connector)
- **What**: All-in-one product analytics — event analytics, session replay, feature
  flags, experiments, surveys, error tracking, a data-warehouse, AND a CDP/pipelines
  layer. `posthog-js`/`posthog-node`/HTTP `/capture`. This IS Guan's **"product
  usage"** signal out of the box.
- **License**: **MIT ("MIT Expat")** outside `ee/`. `ee/` (SSO enforcement, advanced
  RBAC, audit logs, some enterprise analytics, billing) = PostHog Enterprise License.
  **`PostHog/posthog-foss`** = clean fully-MIT mirror. `posthog-node` verified **MIT**.
- **Self-hostable?**: Yes — free Docker Compose "hobby deploy," **~100k events/mo**;
  no OSS support, big users steered to Cloud. Fine for demo/dev.
- **Maturity**: Very high — large active project, first-class SDKs, MCP server, free
  cloud tier (1M events/mo).
- **Plug-in**: (a) **read adapter** — poll `/api/projects/:id/events` or `/query`
  (HogQL) with a personal API key → normalize; (b) **push** — PostHog CDP
  webhook-forward. Event JSON trivially fixtured for offline.
- **Verdict**: **ADOPT as the product-usage connector.** MIT + purpose-built;
  highest-value real adapter to ship first. Not bundled in the offline core.
- Src: https://github.com/PostHog/posthog · https://posthog.com/docs/self-host ·
  https://github.com/PostHog/posthog-foss

### crowd.dev / LFX CDP — Apache-2.0 community-signal platform — ADOPT/NOTE (OSS Common Room)
- **What**: The **closest OSS analog to Common Room / Orbit** — a Community Data
  Platform that ingests signals across GitHub, Discord, Slack, Hacker News, etc.,
  with **identity resolution** and activation. Exactly the "unify community/customer
  signals" job, open-source.
- **License**: **Apache-2.0** (verified). **Acquired by the Linux Foundation
  (Apr 2024)**, renamed **LFX Community Data Platform**; repo
  `linuxfoundation/crowd.dev` (formerly `CrowdDotDev/crowd.dev`) — **actively
  developed as of Jul 2026**.
- **Self-hostable?**: Yes (Docker); heavier stack (its own DB + services).
- **Maturity**: High and rising — now LF-backed, which de-risks abandonment (unlike
  Orbit, which shut down).
- **Plug-in**: Two paths — (a) **read adapter** against its API for
  already-resolved member/activity signals; (b) **borrow its ingestion model** for
  our own lightweight GitHub/HN adapters. For a turnkey OSS "signal unification"
  engine, this is the reference to point users at.
- **Verdict**: **NOTE as the turnkey OSS Common Room; ADOPT its model.** Too heavy to
  bundle for offline v1, but it validates the architecture and is the best "graduate
  to a real engine" target. Its Apache-2.0 + LF backing make it the safest
  heavyweight in this whole document.
- Src: https://github.com/linuxfoundation/crowd.dev · https://github.com/CrowdDotDev/crowd.dev

### Grouparoo — reverse-ETL — SKIP (DEAD)
- **Status**: **Acquired by Airbyte Apr 2022; repos archived, no contributions.**
  Runnable but unmaintained. Successor = Multiwoven.
- **Verdict**: **SKIP — never adopt an archived project.**
- Src: https://www.grouparoo.com/blog/grouparoo-acquired-by-airbyte

### Multiwoven — AGPL-3.0 reverse-ETL (Grouparoo successor) — NOTE (activation, not ingestion)
- **What**: OSS reverse-ETL — warehouse → business tools. Live alternative to
  Hightouch/Census/RudderStack.
- **License**: **AGPL-3.0 core + MIT connectors** (verified). Self-hostable, active.
- **Verdict**: **NOTE, don't bundle.** Belongs to the outreach/activation layer.
  (AGPL on the core is also a reason to keep it out of our bundled deps.)
- Src: https://github.com/Multiwoven/multiwoven

### Airbyte — source-available ETL (+ reverse-ETL) — NOTE (real-connector firehose)
- **What**: Dominant OSS data-integration platform — hundreds of source connectors
  (CRM, ads, product) → warehouse; growing reverse-ETL.
- **License**: mixed — MIT + Elastic License 2.0 on parts; connectors mostly MIT.
- **Self-hostable?**: Yes (Docker/K8s), heavy (temporal/minio).
- **Verdict**: **NOTE as the "bring-your-own-warehouse" firehose** for CRM +
  campaign-engagement at scale. Not bundled. Its connector JSON schemas model our
  normalized shapes.
- Src: https://github.com/topics/reverse-etl

---

## Open intent / community signal sources (the Common Room / ZoomInfo-intent replacement)
Commercial intent data (Bombora, ZoomInfo, Common Room's identity graph) is
proprietary. But the **raw signals** underneath dev/community intent are PUBLIC and
free to ingest — that's the whole trick:

| Source | Access | Auth | Offline sample? |
|---|---|---|---|
| **GitHub** (stars/forks/PRs/issues/watch) | REST/GraphQL API; `@octokit/rest` (MIT) | free PAT, 5k req/hr | **Yes** — GH Archive (gharchive.org) / BigQuery public dataset → JSONL slice |
| **Hacker News** | Algolia HN API | none | Yes — HN API is fully open |
| **Reddit** | Reddit API | free app token | Yes |
| **npm / PyPI / Docker pulls** | registry download-count APIs | none | Yes |
| **RSS / news / Product Hunt** | RSS + PH API | mostly none | Yes |

- **Common Room** itself is "GitHub listening" + an identity graph. Our open version
  reproduces the *ingestion* (public events); the proprietary *identity enrichment*
  stays a pluggable commercial slot (or use **LFX CDP** for OSS identity resolution).
- **Commercial-only → SKIP (keep as pluggable slot)**: Reo.dev, Clearcue,
  LeadCognition, Orbit (shut down), ZoomInfo/Bombora.
- Src: https://www.commonroom.io/blog/github-listening/ ·
  https://leadcognition.io/blog/developer-signal-intelligence-guide

---

## Warehouse-native / webhook capture + the Segment HTTP spec
The lowest-friction, most durable ingestion contract is **not a product** — it's the
**Segment HTTP Tracking API spec**, which every CDP-class tool already speaks:

- **Methods**: `identify` (user + traits), `track` (action + properties), `page`,
  `group`, `alias`, `screen`, plus `batch` (array of the above).
- **Transport**: plain HTTP `POST` of JSON. No SDK required to *receive* it — a
  webhook endpoint that validates the documented shape is enough.
- **Why this is the wire format**: Jitsu, RudderStack, Segment, and OpenSnowcat can
  ALL emit Segment-spec events to a webhook destination. By making our ingest
  endpoint Segment-spec-compatible, we get all of them as connectors for free, and
  we depend on a spec (stable, permissive to implement) rather than any one
  source-available product.
- **Warehouse-native variant**: for users who already land events in a warehouse
  (via Airbyte/Snowplow/RudderStack), a **SQL-read adapter** (parameterized query →
  normalized Signal) covers the "bring-your-own-warehouse" path with no streaming.
- **Package note**: Segment's own `@segment/analytics-node` is **MIT** (verified) and
  useful for its TypeScript event *types*, but it's a *sender*; for a *receiver* we
  only need to validate JSON against the spec (use `zod`), so it's optional.
- Src: https://developer.segment.com/docs/connections/sources/catalog/libraries/server/http-api ·
  https://github.com/segmentio/analytics-node (MIT)

---

## How it plugs into a TypeScript workflow runtime — the `SignalSource` adapter
One small interface. The offline JSONL fixture source and every real connector are
just implementations of it. This is the "clean adapter interface for real connectors"
the task asks for.

```ts
// A normalized signal — the ONE shape the rest of the stack reasons about.
// Modeled on the Segment spec (identify/track) unified with intent events.
export interface Signal {
  id: string;                       // stable dedupe key
  ts: string;                       // ISO-8601
  source: string;                   // "posthog" | "github" | "segment-webhook" | "sample" ...
  kind: "product_usage" | "crm" | "campaign" | "intent" | "identify";
  actor: {                          // who (person/account), best-effort resolved
    userId?: string; anonId?: string;
    email?: string; company?: string; handle?: string;
  };
  action?: string;                  // "track" event name / "star" / "page_view"
  traits?: Record<string, unknown>; // identify traits
  properties?: Record<string, unknown>;
  raw?: unknown;                     // original payload for audit
}

// Every source implements this. Pull sources yield; push sources are fed by a webhook.
export interface SignalSource {
  name: string;
  mode: "pull" | "push";
  // pull: fetch a page/window of signals (offline fixture, PostHog, GitHub, SQL)
  pull?(cursor?: string): Promise<{ signals: Signal[]; nextCursor?: string }>;
  // push: normalize one inbound webhook body (Segment-spec, RudderStack, Jitsu)
  normalize?(body: unknown): Signal[];
}
```

Concrete adapters (all thin, all optional except the bundled sample):

- **`SampleSource` (DEFAULT, offline)** — reads `data/signals.sample.jsonl` and
  yields `Signal[]`. Zero network, zero credentials. This is what makes the stack
  run offline out of the box. Fixtures include a mix of `product_usage` (PostHog-
  shaped), `crm` (HubSpot-shaped), `campaign` (email-open-shaped), and `intent`
  (GitHub-star-shaped) rows so downstream agents have all four Guan signal types.
- **`SegmentWebhookSource` (push)** — an HTTP route that validates the Segment spec
  with `zod` and maps `identify`/`track`/`page`/`group` → `Signal`. Instantly
  compatible with Jitsu, RudderStack, Segment, OpenSnowcat.
- **`PostHogSource` (pull)** — `posthog-node` / REST `/query` (HogQL) → `Signal`
  (`kind:"product_usage"`).
- **`GitHubSignalSource` (pull)** — `@octokit/rest` → stars/forks/issues/PRs as
  `Signal` (`kind:"intent"`). Also the generator for the bundled sample (dump a GH
  Archive slice to JSONL).
- **`SqlWarehouseSource` (pull)** — parameterized query against a user's warehouse
  (Postgres/BigQuery/Snowflake) → `Signal`. The "bring-your-own-warehouse" path.

The runtime only ever sees `Signal`. Swapping the sample fixture for a real PostHog
or GitHub key is a one-line source registration — nothing downstream changes.

---

## Summary verdict table

| Tool | Type | License | Self-host | Maturity | Verdict |
|---|---|---|---|---|---|
| **Jitsu** | Event ingestion (CDP) | **MIT** | Yes (Docker) | Med-High | **ADOPT** (optional real connector; model wire format) |
| **PostHog** | Product analytics + CDP | **MIT** (core) | Yes (~100k ev/mo) | Very High | **ADOPT** (product-usage connector) |
| **crowd.dev / LFX CDP** | Community signal (Common Room analog) | **Apache-2.0** | Yes | High (LF-backed) | **NOTE/ADOPT model** (turnkey OSS graduation target) |
| **OpenSnowcat** | Behavioral pipeline | **Apache-2.0** | Yes | Med | NOTE (Snowplow escape hatch) |
| **GitHub / HN / Reddit APIs** | Public intent signals | Free APIs | n/a | High | **ADOPT** (open intent ingestion) |
| **Airbyte** | ETL connector firehose | MIT + ELv2 | Yes (heavy) | Very High | NOTE (bring-your-own-warehouse) |
| **RudderStack** | CDP | **ELv2** (src-avail) | Yes (heavy) | High | SKIP-as-dep / EXTEND-compat (webhook) |
| **Snowplow** | Behavioral pipeline | **SLULA** (src-avail) | Licensed | Very High | SKIP (use OpenSnowcat) |
| **Multiwoven** | Reverse-ETL | **AGPL-3.0** core | Yes | Med | NOTE (activation, not ingestion) |
| **Grouparoo** | Reverse-ETL | archived | Dead | Dead | **SKIP** |
| Common Room / ZoomInfo / Bombora / Reo.dev / Clearcue / Orbit | Commercial intent | Proprietary | No | — | SKIP (pluggable commercial slot) |

---

## FINAL DEFAULT for v1

**Default = our own `SignalSource` interface + a bundled JSONL sample dataset, with
three thin real adapters behind it.** No heavyweight CDP is bundled; every real
engine (Jitsu, PostHog, crowd.dev/LFX CDP, a warehouse) is an *optional* source the
user opts into. This satisfies both constraints: runs offline with sample data, and
has a clean adapter interface for real connectors.

- **Offline default source**: `SampleSource` over `data/signals.sample.jsonl`
  (product_usage + crm + campaign + intent rows). Zero deps, zero creds.
- **First real connectors** (opt-in): `SegmentWebhookSource` (covers Jitsu/
  RudderStack/Segment via the spec — no package needed), `PostHogSource`,
  `GitHubSignalSource`.
- **Graduation target** for users who want a turnkey OSS signal engine: **LFX CDP
  (crowd.dev, Apache-2.0)** or **Jitsu (MIT)**.

### The 2–3 concrete packages to install (all verified MIT)
```bash
npm i zod posthog-node @octokit/rest
```
1. **`zod`** (MIT, `colinhacks/zod`) — defines + validates the `Signal` schema and
   the inbound Segment-spec webhook payloads. This is the backbone of the "clean
   adapter interface"; it needs no network, so it also guards the offline fixtures.
2. **`posthog-node`** (MIT, `PostHog/posthog-node`) — the first real connector
   (product-usage signal). Also lets the stack *emit* its own events if desired.
3. **`@octokit/rest`** (MIT, `octokit/rest.js`) — the first real intent connector
   (public GitHub signals) and the generator for the bundled offline sample.

_Optional:_ `@segment/analytics-node` (MIT) only if you want Segment's TS event
*types*; not required, since a webhook receiver just validates JSON with `zod`.

**Why not a CDP as the dep**: RudderStack (ELv2) and Snowplow (SLULA) are
source-available and heavy; bundling them is a licensing + ops burden for an open
stack. Jitsu (MIT) and PostHog (MIT) are the right *optional* engines, but the
offline-first, clean-adapter requirement is met better by owning a 30-line interface
+ JSONL fixtures than by taking a hard dependency on any one product.
