# A — Signal / Intent Ingestion: Free & Open-Source Tools

> Research file for the OPEN "Marketing Agents in Production" stack.
> Layer: **SIGNAL / INTENT INGESTION** (Guan's "Unify Customer Signals": CRM +
> product usage + campaign engagement + web/3rd-party intent).
> Goal: a drop-in OSS alternative to closed SaaS (Common Room, Segment, Unify,
> ZoomInfo intent) that **runs offline with a bundled sample dataset** and
> **optionally connects real sources** through a clean TS adapter interface.
> Author: researcher agent · Date: 2026-07-20

## Progress tracker
- [x] RudderStack — license + self-host
- [x] Jitsu — license + self-host
- [x] Snowplow — license (SLULA) + OpenSnowcat fork
- [x] Grouparoo — reverse-ETL status (dead)
- [x] PostHog — license + self-host + product analytics
- [x] Open reverse-ETL alternatives (post-Grouparoo) — Multiwoven, Airbyte
- [x] Open intent / signal sources (Common Room alt, GitHub/community signals)
- [x] crowd.dev / Orbit status (OSS community-signal)
- [x] Warehouse-native / webhook capture patterns + Segment HTTP spec
- [x] TS adapter interface design
- [x] Final DEFAULT recommendation + packages to install

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
   identity enrichment, which stays a pluggable commercial slot).

Concrete packages to install: see the final section. TL;DR:
`@segment/analytics-node` (spec + types, MIT), `posthog-node` (MIT), `zod` (schema
validation for the adapter contract). Everything else is a documented
"bring-your-own" real connector, not a bundled dependency.

---

## Tool-by-tool findings

### RudderStack — source-available CDP (Segment alternative)
- **What it does**: Warehouse-native customer data platform. Collects events via
  SDKs/HTTP, transforms, routes to warehouses + 200+ destinations. The "Segment
  alternative for data engineers." Go (`rudder-server`) + React.
- **License**: **Elastic License 2.0 (ELv2)** on `rudder-server` + the self-hosted
  project — **source-available, NOT OSI open source** (ELv2 forbids offering it as
  a managed service to third parties). Earlier: AGPL-3.0 core + MIT SDKs. SDKs and
  many integrations remain permissive.
- **Self-hostable?**: Yes (Docker/Helm), same core for Community + Enterprise, but
  wants Postgres + a warehouse; operationally non-trivial.
- **Maturity**: High. v1.0 with 170+ contributors, widely deployed, active.
- **How it plugs in as a signal source**: Its SDKs/HTTP speak the **Segment spec**.
  Point a RudderStack "webhook" destination at our runtime → our adapter parses the
  Segment-shaped JSON. We target the spec, not the product.
- **Verdict**: **SKIP as a bundled dependency** (ELv2 + heavy). **EXTEND-compatible**
  — accept its Segment-shaped webhook output as one real connector.
- Sources: https://github.com/rudderlabs/rudder-server ·
  https://www.rudderstack.com/docs/get-started/rudderstack-open-source/ ·
  https://www.rudderstack.com/blog/rudderstacks-licensing-explained/

### Jitsu — MIT open-source data collection (Segment alternative)
- **What it does**: Open-source, fully-scriptable event ingestion engine. Captures
  events (JS SDK / HTTP API), lightweight JS transforms, routes to warehouses
  (Snowflake, BigQuery, Redshift, Postgres, MySQL, ClickHouse). Jitsu 2.0 is current.
- **License**: **MIT** — genuinely OSI open source. The key differentiator vs
  RudderStack/Snowplow.
- **Self-hostable?**: Yes — designed for it; fastest path Docker Compose. Cloud tier
  free to 200k events/mo with bundled ClickHouse.
- **Maturity**: Medium-high. Active, Segment-compatible SDKs; smaller community than
  Snowplow/RudderStack but MIT + self-host-friendly.
- **How it plugs in as a signal source**: (a) run Jitsu, use its Segment-compatible
  ingestion, forward to our webhook; or (b) skip running it and just adopt its
  **Segment-compatible event shape** as our wire format. `@jitsu/js` on npm.
- **Verdict**: **ADOPT as the recommended optional real connector / model our wire
  format on it.** Best-licensed CDP-class tool. Still too heavy to *bundle* for
  offline v1, but the one to recommend for a full self-hosted pipeline.
- Sources: https://github.com/jitsucom/jitsu · https://jitsu.com/ ·
  https://next.jitsu.com/features/segment-compatibility

### Snowplow — source-available behavioral data platform
- **What it does**: The most mature behavioral-data pipeline. Rich strongly-typed
  event schemas (self-describing JSON + Iglu schema registry), collector → enrich →
  warehouse. Gold standard for behavioral event modeling.
- **License**: **Snowplow Limited Use License Agreement (SLULA)** since Jan 2024
  (v1.1 Dec 2024) — **source-available, NOT open source**; test/academic/
  non-production only, **production/commercial requires a paid license**. Was
  Apache-2.0.
- **Open fork**: **OpenSnowcat** — Apache-2.0 fork of pre-SLULA Snowplow, compatible
  with Snowplow + Segment SDKs (SnowcatCloud). The genuinely-open path.
- **Self-hostable?**: Snowplow — technically yes, but SLULA bars production
  self-host without a license. OpenSnowcat — yes, Apache-2.0, unrestricted.
- **Maturity**: Very high (Snowplow); OpenSnowcat newer but tracks a mature base.
- **How it plugs in**: Emits enriched events to a stream/warehouse; our adapter
  reads that sink. Heavy for our use case.
- **Verdict**: **SKIP for v1** (over-engineered for a marketing-signal demo; SLULA on
  the main line). If a user already runs it, provide a warehouse-read adapter. Note
  OpenSnowcat as the Apache-2.0 escape hatch.
- Sources: https://docs.snowplow.io/docs/resources/limited-use-license-faq/ ·
  https://snowplow.io/blog/introducing-snowplow-limited-use-license ·
  https://www.snowcatcloud.com/snowplow/open-source/

### PostHog — MIT product analytics + CDP (self-hostable)
- **What it does**: All-in-one product analytics — event analytics, session replay,
  feature flags, experiments, surveys, error tracking, a data-warehouse, AND a
  CDP/pipelines layer. Captures product-usage events via `posthog-js`/`posthog-node`
  or HTTP `/capture`. This IS Guan's **"product usage"** signal out of the box.
- **License**: **MIT ("MIT Expat")** for everything outside `ee/`. The `ee/` dir
  (SSO enforcement, advanced RBAC, audit logs, some enterprise analytics, billing)
  is under the PostHog Enterprise License. **`PostHog/posthog-foss`** is a clean
  fully-MIT mirror with proprietary code stripped.
- **Self-hostable?**: Yes — free Docker Compose "hobby deploy," documented **~100k
  events/mo**; PostHog doesn't support OSS deploys and steers big users to Cloud.
  Fine for demo/dev; not high scale.
- **Maturity**: Very high. Large active project, first-class SDKs, MCP server,
  generous free cloud tier (1M events/mo).
- **How it plugs in as a signal source**: (a) **read adapter** — poll
  `/api/projects/:id/events` or `/query` (HogQL) with a personal API key → normalize
  to our Signal shape; (b) **push** — PostHog CDP can webhook-forward events. Event
  JSON is easy to fixture for offline. `posthog-node` on npm.
- **Verdict**: **ADOPT as the product-usage connector** (optional, real). MIT +
  purpose-built. Not bundled into the offline core (needs its own stack), but the
  highest-value real adapter to ship first.
- Sources: https://github.com/PostHog/posthog · https://posthog.com/docs/self-host ·
  https://github.com/PostHog/posthog-foss ·
  https://github.com/PostHog/posthog/blob/master/LICENSE

### Grouparoo — reverse-ETL (DEAD / archived)
- **What it did**: Open-source reverse-ETL / data-sync (warehouse → systems of
  action), OSS alternative to Hightouch/Census.
- **Status**: **Acquired by Airbyte April 2022; repos archived, no contributions.**
  Runnable but unmaintained. Mission folded into Airbyte.
- **Verdict**: **SKIP — never adopt an archived project.** Closes the "open
  reverse-ETL" loop; the successor is Multiwoven (below).
- Sources: https://www.grouparoo.com/blog/grouparoo-acquired-by-airbyte ·
  https://airbyte.com/blog/airbyte-acquires-grouparoo-to-accelerate-data-movement

---

## Open reverse-ETL (activation side — post-Grouparoo)
Reverse-ETL = warehouse → SaaS "systems of action." For our *ingestion* layer this
is the opposite direction (outreach/activation), recorded for completeness.

### Multiwoven — open-source reverse ETL (Grouparoo successor)
- **What it does**: OSS reverse-ETL — sync customer data from warehouses to business
  tools. The live **alternative to Hightouch / Census / RudderStack**; de-facto
  successor to the dead Grouparoo.
- **License**: AGPL-3.0 (see verification note). Self-hostable, active.
- **Maturity**: Medium; strongest current OSS reverse-ETL entrant.
- **Verdict**: **NOTE, don't bundle.** Belongs to the outreach/activation layer, not
  core ingestion. Cite if the stack later needs warehouse→SaaS activation.
- Source: https://github.com/Multiwoven/multiwoven

### Airbyte — open-source ETL (+ reverse-ETL)
- **What it does**: The dominant open-source data-integration platform — hundreds of
  source connectors (CRM, ads, product tools) → warehouse; growing reverse-ETL.
- **License**: mixed — MIT + Elastic License 2.0 on parts of the platform;
  connectors mostly MIT. Source-available core.
- **Self-hostable?**: Yes (Docker/K8s), heavy (temporal, minio, etc.).
- **Maturity**: Very high; the huge connector catalog is the real asset.
- **How it plugs in**: For real deployments, Airbyte pulls CRM (HubSpot/Salesforce)
  + ad engagement into a warehouse we then read. Too heavy to bundle; ideal as a
  documented "bring-your-own-warehouse" path. Its connector JSON schemas are a good
  model for our normalized shapes.
- **Verdict**: **NOTE as the real-connector firehose.** Not a bundled dep; the
  recommended way to populate CRM + campaign-engagement signals at scale.
- Source: https://github.com/topics/reverse-etl

---

## Open intent / community signal sources (Common Room / ZoomInfo-intent replacement)
Commercial intent data (Bombora, ZoomInfo, Common Room's identity graph) is
proprietary. But the **raw signals** underneath community/dev intent are largely
PUBLIC and free to ingest:

- **GitHub signals** — every star, fork, PR, issue, discussion, release-watch is a
  public interest/buying signal. Free routes:
  - **GitHub REST/GraphQL API** (`/repos/:o/:r/stargazers`, `/events`) — live, free
    PAT auth, 5k req/hr authenticated.
  - **GH Archive** (gharchive.org) + **Google BigQuery public dataset** — the full
    public-GitHub-event firehose, queryable historically. Ideal for a **bundled
    offline sample** (download a slice as JSONL).
- **Common Room** itself is built on "GitHub listening." Our open version reproduces
  the *ingestion* (public GitHub events) without the proprietary identity graph.
- **Other free public signal streams**: Hacker News (Algolia HN API — fully open, no
  auth), Reddit API, npm/PyPI/Docker download counts, RSS/news, Product Hunt. These
  map to "web / 3rd-party intent."
- **Not OSS (commercial-only → skip, keep as pluggable slot)**: Reo.dev, Clearcue,
  LeadCognition, Orbit (shut down), ZoomInfo/Bombora. No open drop-in for their
  *identity enrichment* — that stays a pluggable commercial adapter.
- Sources: https://www.commonroom.io/blog/github-listening/ ·
  https://clearcue.ai/blog/common-room-alternatives-signal-tracking ·
  https://leadcognition.io/blog/developer-signal-intelligence-guide

---

_(continued — crowd.dev status, Segment HTTP spec, TS adapter design, final default below)_
