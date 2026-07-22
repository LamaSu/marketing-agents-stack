/**
 * firecrawlFetchSite — a `FetchSite` (see `llm-web.ts`) backed by Firecrawl's HOSTED
 * scrape API (https://api.firecrawl.dev). Opt-in, lowest-trust escape hatch for
 * hard-to-fetch pages (heavy JS rendering, anti-bot defenses) that even a Crawl4AI
 * sidecar (`./crawl4ai.ts`) cannot reach, per research/10-sota-integration-design.md
 * §2.5 (Wave D3).
 *
 * LICENSE BOUNDARY (read before touching this file): Firecrawl's own engine is
 * AGPL-3.0 (`firecrawl/firecrawl` on GitHub) and is NEVER vendored into this MIT tree.
 * This file only ever speaks plain HTTPS to Firecrawl's HOSTED API -- calling a remote
 * API does not trigger AGPL copyleft (docs/build-conventions.md's license-hygiene
 * rule; research/10-sota-integration-design.md §3, boundary 2). Firecrawl's own SDK
 * (`firecrawl`, MIT) is deliberately NOT used here either -- a raw `fetch` call keeps
 * this package's dependency list unchanged and keeps the wire shape under our own
 * typing, same rationale as `llm-web.ts`'s hand-declared `ClaudeMessagesClient`.
 *
 * OPT-IN, EXPLICIT KEY ONLY: `apiKey` is a secret and is a REQUIRED config field --
 * unlike `crawl4aiFetchSite`'s `CRAWL4AI_URL` (not a secret, safe to default from env),
 * this module never reads an API key from `process.env` itself. A caller who keeps the
 * key in an env var reads it and passes it in explicitly:
 * `createFirecrawlFetchSite({ apiKey: process.env["FIRECRAWL_API_KEY"] ?? "" })`. This
 * keeps "opt-in" honest -- importing this module, or even constructing a provider some
 * other way, never silently sends a real domain to a third-party paid API.
 *
 * LOWEST TRUST, UNCHANGED TRUST ORDER: this is the paid, hosted, lowest-trust
 * `FetchSite` in the stack. `mergeEnrichment`'s `registry > llm-web > paid` order
 * (`merge.ts`) ranks by `EnrichmentRecord.source`, which stays `"llm-web"` regardless
 * of which `FetchSite` fed it -- `crawl4aiFetchSite` and `firecrawlFetchSite` both feed
 * `llm-web` at the *fetch* layer, not the *record* layer, so this file makes zero
 * change to that trust order or to the offline `sample` default.
 *
 * LIVE-VERIFIED (2026-07-22, via `curl` of Firecrawl's public GitHub README -- this
 * offline build session has no API key and could not call the real endpoint, see
 * docs/build-conventions.md): the current hosted endpoint is
 * `POST https://api.firecrawl.dev/v2/scrape`, auth is an `Authorization: Bearer fc-<key>`
 * header, and the minimal request body is `{"url": "<url>"}` (this client also sends
 * `formats: ["markdown"]` for a deterministic response shape).
 *
 * ASSUMPTION -- VERIFY ON THE SPARK BUILD (a real key + live call could confirm this
 * exactly; this session could only confirm the *shape family*, not the single-scrape
 * envelope verbatim): the single-URL `/v2/scrape` response is
 * `{"success": true, "data": {"markdown": "<string>", "metadata"?: {...}}}` and a
 * failure response is `{"success": false, "error": "<message>"}`. This is inferred by
 * symmetry with the *confirmed* `/v2/crawl` response (`{"success":true,"data":[{...}]}`,
 * an array of the same per-page document shape -- crawl covers many pages, scrape
 * covers one) and matches this session's general knowledge of Firecrawl's v1/v2 API
 * (independent agreement, not a single unverified source). If a live call's shape
 * differs, widen `FirecrawlScrapeResponse` / `extractFirecrawlMarkdown` below --
 * callers (`llm-web.ts`, `factory.ts`) never need to change, exactly like the
 * `crawl4ai.ts` contract. Full verification notes: `research/wave-d-impl-firecrawl-D3.md`.
 */
import { defaultFetchSite, type FetchSite } from "./llm-web.js";

export interface FirecrawlFetchSiteConfig {
  /** Firecrawl API key (format `fc-...`). REQUIRED and explicit -- a secret, so unlike
   *  `crawl4aiFetchSite`'s `CRAWL4AI_URL` this is never auto-read from an env var
   *  inside this module. Read `process.env["FIRECRAWL_API_KEY"]` yourself and pass it
   *  in if that's where you keep it. */
  apiKey: string;
  /** Firecrawl hosted API base URL. Defaults to `https://api.firecrawl.dev`. Override
   *  only for a self-hosted Firecrawl instance -- still reached over plain HTTP, so the
   *  AGPL core still never enters this tree either way. */
  baseUrl?: string;
  /** injectable fetch -- defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort the API call after this many ms and fall back (a hung anti-bot/JS-render
   *  pass is the expected slow case -- Firecrawl's own docs cite ~3.4s p95 for a normal
   *  page, but the whole reason to reach for this fetcher is the pages that are NOT
   *  normal). Default 20000. */
  timeoutMs?: number;
  /** used on ANY API error (unreachable, non-OK, timeout, `success:false`, or
   *  malformed/empty response). Defaults to `defaultFetchSite` -- degraded, never
   *  broken, exactly like `crawl4aiFetchSite`. Injectable so tests can observe the
   *  fallback without hitting the real network `defaultFetchSite` itself would call. */
  fallbackFetchSite?: FetchSite;
}

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 20_000;

interface FirecrawlDocumentData {
  markdown?: string | null;
  metadata?: Record<string, unknown>;
}
interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: FirecrawlDocumentData | null;
  error?: string;
}

function extractFirecrawlMarkdown(data: FirecrawlDocumentData | null | undefined): string {
  return typeof data?.markdown === "string" ? data.markdown : "";
}

/**
 * Build a `FetchSite` backed by Firecrawl's hosted `/v2/scrape` API. On ANY failure
 * (network error, non-OK status, timeout, `success:false`, or empty/unparseable
 * content) it logs a warning and calls `fallbackFetchSite` (default `defaultFetchSite`)
 * instead of throwing -- degraded, never broken, exactly like `createCrawl4aiFetchSite`.
 *
 * Lowest-trust, opt-in only -- nothing in this package constructs this automatically;
 * a caller must explicitly build it and pass it as `fetchSite`:
 * `enrichmentProvider("llm-web", { client, fetchSite: createFirecrawlFetchSite({ apiKey }) })`.
 */
export function createFirecrawlFetchSite(config: FirecrawlFetchSiteConfig): FetchSite {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error(
      "createFirecrawlFetchSite: config.apiKey is required -- Firecrawl is a paid " +
        "hosted API and the key is a secret, so it is never read from an ambient env " +
        'var automatically. Pass process.env["FIRECRAWL_API_KEY"] explicitly if that\'s ' +
        "where you store it.",
    );
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackFetchSite = config.fallbackFetchSite ?? defaultFetchSite;

  return async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/v2/scrape`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`firecrawl API at ${baseUrl} responded ${res.status}`);
      }
      const json = (await res.json()) as FirecrawlScrapeResponse;
      if (json.success === false) {
        throw new Error(`firecrawl API reported failure: ${json.error ?? "unknown"}`);
      }
      const markdown = extractFirecrawlMarkdown(json.data).trim();
      if (!markdown) {
        throw new Error("firecrawl API returned empty content");
      }
      return markdown;
    } catch (err) {
      console.warn(
        `[@mstack/adapters-enrichment] firecrawlFetchSite: API call to ${baseUrl} failed for ${url} ` +
          `(${String(err)}); falling back to defaultFetchSite (degraded, not broken)`,
      );
      return fallbackFetchSite(url);
    } finally {
      clearTimeout(timer);
    }
  };
}
