# Crawl4AI sidecar (production fetcher for `adapters-enrichment`'s `llm-web`)

Deployment note, not application code — see
`packages/adapters-enrichment/src/crawl4ai.ts` for the TS client and
`research/10-sota-integration-design.md` §2.5 (Wave A1) for the design context.

Crawl4AI (Apache-2.0, `unclecode/crawl4ai`) is Python. Per
`docs/build-conventions.md`'s sidecar rule it is never vendored into this repo's TS
tree — it runs as its own Docker container, reached over plain HTTP.

## Run it

```bash
docker run -d \
  --name crawl4ai \
  -p 11235:11235 \
  --shm-size=1g \
  unclecode/crawl4ai:latest
```

`--shm-size=1g` matters: Crawl4AI drives a headless Chromium under the hood, and the
default 64 MB `/dev/shm` Docker gives a container is enough to crash it on real pages.
Pin an explicit version tag (not `:latest`) once you've verified the API shape below
against the image you're running — `:latest` is a moving target.

## Point the TS code at it

Default (zero config): `crawl4aiFetchSite` targets `http://localhost:11235`.

Override via env var:

```bash
export CRAWL4AI_URL=http://crawl4ai.internal:11235
```

or per-call config:

```ts
import { createCrawl4aiFetchSite, enrichmentProvider } from "@mstack/adapters-enrichment";

const fetchSite = createCrawl4aiFetchSite({ baseUrl: "http://crawl4ai.internal:11235" });
const provider = enrichmentProvider("llm-web", { client, fetchSite });
```

## The trafilatura pre-pass (optional)

Crawl4AI's own default content filter (`PruningContentFilter`, exposed as
`fit_markdown` in its response) is usually clean enough and is what
`crawl4aiFetchSite` prefers automatically. If a deployer wants trafilatura's
(Apache-2.0) boilerplate-stripping specifically — e.g. it out-performs the default
filter on a particular site's markup — that's a *sidecar-side* choice: wire it in as
Crawl4AI's custom `content_filter` callback, or run it as a second pass inside the same
container/image. It never runs in, or is called from, the TS tree — the TS client only
ever speaks HTTP to whatever the sidecar returns as `fit_markdown`/`raw_markdown`.

## The HTTP contract this client assumes (verify against your image's version)

This was written without a live Crawl4AI instance to test against (offline build
session, see `docs/build-conventions.md`) — verify on first real use and adjust
`Crawl4aiCrawlResponse` / `extractMarkdown` in `crawl4ai.ts` if your image's shape
differs. Callers (`llm-web.ts`, `factory.ts`) never need to change.

```
POST {baseUrl}/crawl
  request:  { "urls": ["https://example.com"] }
  response: { "results": [ { "url", "success", "markdown": <string> | { "fit_markdown"?, "raw_markdown"? }, "error_message"? } ] }
```

`fit_markdown` is preferred; `raw_markdown`, then a plain string `markdown`, are
accepted fallbacks.

## Offline default — nothing requires this sidecar

`mstack demo` never calls `crawl4aiFetchSite` — the offline `sample` provider stays
the default (`docs/build-conventions.md`, `research/06-architecture.md` §5.1). Even
where `crawl4aiFetchSite` *is* wired in, any sidecar failure (down, timeout, bad
response) logs a warning and falls back to `defaultFetchSite` (plain fetch + tag-strip)
automatically — degraded, never broken.
