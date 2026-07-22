# Firecrawl (opt-in, lowest-trust) + BYO anti-bot fetcher

Deployment note, not application code — see
`packages/adapters-enrichment/src/firecrawl.ts` and
`packages/adapters-enrichment/src/anti-bot.ts` for the TS clients, and
`research/10-sota-integration-design.md` §2.5 (Wave D3) for the design context.
Pairs with `docker/crawl4ai.md` (the other `FetchSite`, see `llm-web.ts`) — read that
first if you haven't; this doc assumes the same seam.

## Opt-in, lowest-trust — read this before wiring it in

Both fetchers in this doc are **opt-in escape hatches**, not defaults:

- `mstack demo` (the offline demo path) never calls either of them. The `sample`
  provider stays the default enrichment provider; nothing here changes that.
- `mergeEnrichment`'s trust order (`registry(CC0) > llm-web > paid`, in `merge.ts`) is
  **completely untouched**. Both `firecrawlFetchSite` and the anti-bot fetcher only
  change *how* the `llm-web` provider fetches page text before Claude extracts facts
  from it — the resulting `EnrichmentRecord.source` is still `"llm-web"` either way, so
  keyless GLEIF/EDGAR/Wikidata records still win on any conflicting field. Firecrawl (a
  paid hosted API) is the **lowest-trust tier** a deployer can opt into, one rung below
  a self-hosted Crawl4AI sidecar (`docker/crawl4ai.md`), which is itself below the free
  keyless registries.

## Firecrawl — license boundary (read this before touching the code)

Firecrawl's own crawling/scraping **engine** is **AGPL-3.0**
(`firecrawl/firecrawl` on GitHub) and is **never vendored** into this MIT-licensed
tree — not as a dependency, not as copied source. `firecrawl.ts` only ever speaks
plain HTTPS to Firecrawl's **hosted** API. Calling a remote API over HTTP does not
trigger AGPL copyleft (`research/10-sota-integration-design.md` §3, boundary 2 —
"hosted API boundary"). Firecrawl also publishes an MIT-licensed SDK
(`firecrawl` on npm) — this package deliberately does **not** depend on it either,
to keep `package.json` unchanged and keep the wire shape under our own hand-typed
control (same rationale as `llm-web.ts`'s hand-declared `ClaudeMessagesClient`, and
`crawl4ai.ts`'s hand-typed sidecar response). `firecrawlFetchSite` is a plain `fetch`
call — nothing from Firecrawl's repo is imported, copied, or run in-process.

If you ever *self-host* Firecrawl's engine (their AGPL core is source-available for
self-hosting), that's still fine under the same rule Crawl4AI uses: it runs as its
own separate process/container, reached over HTTP — the license boundary is the
process boundary, same as any other sidecar in this stack.

## Configure it (opt-in, explicit key only)

Unlike `CRAWL4AI_URL` (not a secret, safe to default from an env var inside the
module), `FIRECRAWL_API_KEY` is a secret. `firecrawl.ts` **never reads it from
`process.env` automatically** — you read it yourself and pass it in explicitly. This
is deliberate: importing this module, or even constructing a `LlmWebProvider`, never
silently starts sending your data to a third-party paid API.

```ts
import { createFirecrawlFetchSite, enrichmentProvider } from "@mstack/adapters-enrichment";

const fetchSite = createFirecrawlFetchSite({
  apiKey: process.env["FIRECRAWL_API_KEY"] ?? "", // read + pass explicitly -- your choice, your opt-in
});
const provider = enrichmentProvider("llm-web", { client, fetchSite });
```

Sign up at [firecrawl.dev](https://firecrawl.dev) for a key (format `fc-...`).
Constructing without a key throws immediately (`config.apiKey is required`) rather
than silently doing nothing.

## The HTTP contract this client assumes (verify against a live call — see caveat below)

**Live-verified 2026-07-22** (via `curl` of Firecrawl's public GitHub README — this
build session had no API key to call the real endpoint with, per
`docs/build-conventions.md`'s offline-build convention):

```
POST https://api.firecrawl.dev/v2/scrape
  headers: Authorization: Bearer fc-<your-key>
  request:  { "url": "https://example.com", "formats": ["markdown"] }
```

**ASSUMPTION — not live-confirmed**, inferred by symmetry with the confirmed
`/v2/crawl` response shape (`{"success":true,"data":[{"markdown","metadata"},...]}`,
an array because crawl covers many pages) collapsed to one document for a single-page
scrape:

```
  response (ok):    { "success": true, "data": { "markdown": "<string>", "metadata"?: {...} } }
  response (error): { "success": false, "error": "<message>" }
```

If a live call's shape differs, widen `FirecrawlScrapeResponse` /
`extractFirecrawlMarkdown` in `firecrawl.ts` — callers (`llm-web.ts`, `factory.ts`)
never need to change. Full verification trail:
`research/wave-d-impl-firecrawl-D3.md` (gitignored, local-only).

## Degrade, never break

Same contract as every other seam default in this package: on **any** failure
(unreachable, non-OK status, timeout, `success:false`, or empty/unparseable content)
`firecrawlFetchSite` logs a warning and calls `fallbackFetchSite` (default
`defaultFetchSite`, i.e. plain fetch + tag-strip) instead of throwing.

## BYO anti-bot fetcher — the free/self-managed alternative

`createAntiBotFetchSite` (`anti-bot.ts`) is a **clean-room** rebuild of the
*concept* behind Firecrawl's anti-bot handling — rotate identity (User-Agent, and
optionally a proxy) across retries with backoff — written from the design doc's own
one-line description and from Firecrawl's public docs, **never from Firecrawl's
(AGPL) source**. It is the honest free tier one rung above `defaultFetchSite`: no
managed proxy fleet, no JS rendering, no CAPTCHA solving — just UA rotation, optional
proxy rotation, retry, and backoff, for sites that reject a single static UA/IP but
don't need a full hosted service.

```ts
import { createAntiBotFetchSite, enrichmentProvider } from "@mstack/adapters-enrichment";

const fetchSite = createAntiBotFetchSite({
  proxies: ["http://user:pass@proxy1.example:8080", "http://user:pass@proxy2.example:8080"], // optional
  retries: 3,
  backoffMs: 250,
});
const provider = enrichmentProvider("llm-web", { client, fetchSite });
```

**Why there's no built-in proxy transport**: plain `fetch` has no cross-runtime
concept of an HTTP(S) proxy (Node's `fetch` needs an undici `ProxyAgent` dispatcher,
which isn't part of the portable `fetch` signature). Rather than accept a `proxies`
list and silently do nothing with it, this module owns the part that's genuinely
ours to build — rotation, retry count, backoff — and hands the chosen proxy for each
attempt to an **injectable** `fetchImpl(url, { headers, proxy, signal })`. The
default `fetchImpl` does a plain direct fetch and rotates only the `User-Agent`
header (which works with zero extra plumbing); inject your own `fetchImpl` wrapping a
proxy-aware HTTP client (e.g. an undici `ProxyAgent`) if you want the `proxy` value
to actually route traffic.

Same degrade-not-break contract: if every attempt is exhausted, it logs a warning
and falls back to `fallbackFetchSite` (default `defaultFetchSite`).

## Nothing here requires either fetcher

`mstack demo` never calls `firecrawlFetchSite` or the anti-bot fetcher — the offline
`sample` provider stays the default. Both are additive, opt-in `FetchSite` values you
pass explicitly; the keyless registries (GLEIF/EDGAR/Wikidata) and the trust order
they participate in are unaffected either way.
