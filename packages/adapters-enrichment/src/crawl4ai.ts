/**
 * crawl4aiFetchSite — a `FetchSite` (see `llm-web.ts`) backed by a Crawl4AI HTTP
 * sidecar (Apache-2.0, unclecode/crawl4ai, ~71k★, the most-starred OSS crawler) instead
 * of the plain-fetch+tag-strip `defaultFetchSite`. Crawl4AI does JS rendering plus its
 * own content-filtering and returns much cleaner "main content" than a raw HTML strip,
 * per research/10-sota-integration-design.md §2.5 (Wave A1).
 *
 * Crawl4AI is Python. Per docs/build-conventions.md's sidecar rule (Python tools --
 * even Apache/MIT ones -- run as separate processes, never vendored into the strict-ESM
 * TS tree), this file only ever talks to it over HTTP. `docker/crawl4ai.md` has the run
 * command and the trafilatura pre-pass note; nothing here spawns or imports Python.
 *
 * ASSUMPTION -- VERIFY ON THE SPARK BUILD (this package was written without running
 * `pnpm install` or standing up a real Crawl4AI container, per docs/build-conventions.md
 * "do NOT run pnpm locally"): the request/response shape below matches Crawl4AI's
 * documented Docker server `POST /crawl` contract --
 *   request:  { "urls": ["<url>"] }
 *   response: { "results": [ { "url", "success", "markdown": <string> | { "fit_markdown"?, "raw_markdown"? }, "error_message"? } ] }
 * `fit_markdown` (Crawl4AI's own content-filtered "main content" extraction, its
 * default `PruningContentFilter`) is preferred when present; falls back to
 * `raw_markdown`, then a plain string `markdown`, then treats empty content as a
 * failure. If a live sidecar's shape differs, widen `Crawl4aiCrawlResponse` /
 * `extractMarkdown` below -- callers (`llm-web.ts`, `factory.ts`) do not change, and
 * per the design contract, ANY shape mismatch or sidecar failure degrades to the
 * `fallbackFetchSite` (default: `defaultFetchSite`), never a crash.
 */
import { defaultFetchSite, type FetchSite } from "./llm-web.js";

export interface Crawl4aiFetchSiteConfig {
  /** Crawl4AI sidecar base URL (no trailing slash needed -- stripped if present).
   *  Defaults to the `CRAWL4AI_URL` env var, then `http://localhost:11235`
   *  (Crawl4AI's documented default Docker port). */
  baseUrl?: string;
  /** injectable fetch -- defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort the sidecar call after this many ms and fall back (a hung headless-render
   *  is the most common "sidecar down" failure mode, not just connection-refused).
   *  Default 15000. */
  timeoutMs?: number;
  /** used on ANY sidecar error (unreachable, non-OK, timeout, malformed/empty
   *  response). Defaults to `defaultFetchSite` -- degraded, never broken. Injectable
   *  so tests can observe the fallback without hitting the real network that
   *  `defaultFetchSite` itself would call. */
  fallbackFetchSite?: FetchSite;
}

const DEFAULT_BASE_URL = "http://localhost:11235";
const DEFAULT_TIMEOUT_MS = 15_000;

interface Crawl4aiMarkdownObject {
  fit_markdown?: string | null;
  raw_markdown?: string | null;
}
interface Crawl4aiResultEntry {
  url?: string;
  success?: boolean;
  markdown?: string | Crawl4aiMarkdownObject | null;
  error_message?: string;
}
interface Crawl4aiCrawlResponse {
  success?: boolean;
  results?: Crawl4aiResultEntry[];
}

function extractMarkdown(entry: Crawl4aiResultEntry | undefined): string {
  const markdown = entry?.markdown;
  if (typeof markdown === "string") return markdown;
  if (markdown && typeof markdown === "object") {
    return markdown.fit_markdown ?? markdown.raw_markdown ?? "";
  }
  return "";
}

/**
 * Build a `FetchSite` backed by a Crawl4AI sidecar. On ANY failure (sidecar
 * unreachable, non-OK status, timeout, `success:false`, or empty/unparseable content)
 * it logs a warning and calls `fallbackFetchSite` (default `defaultFetchSite`) instead
 * of throwing -- degraded, never broken, exactly like every other seam default in this
 * package.
 */
export function createCrawl4aiFetchSite(config: Crawl4aiFetchSiteConfig = {}): FetchSite {
  const baseUrl = (config.baseUrl ?? process.env["CRAWL4AI_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackFetchSite = config.fallbackFetchSite ?? defaultFetchSite;

  return async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`crawl4ai sidecar at ${baseUrl} responded ${res.status}`);
      }
      const json = (await res.json()) as Crawl4aiCrawlResponse;
      const entry = json.results?.[0];
      if (entry && entry.success === false) {
        throw new Error(`crawl4ai sidecar reported failure: ${entry.error_message ?? "unknown"}`);
      }
      const markdown = extractMarkdown(entry).trim();
      if (!markdown) {
        throw new Error("crawl4ai sidecar returned empty content");
      }
      return markdown;
    } catch (err) {
      console.warn(
        `[@mstack/adapters-enrichment] crawl4aiFetchSite: sidecar at ${baseUrl} failed for ${url} ` +
          `(${String(err)}); falling back to defaultFetchSite (degraded, not broken)`,
      );
      return fallbackFetchSite(url);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Ready-to-use default instance -- `CRAWL4AI_URL` env (or `http://localhost:11235`) +
 * global fetch + `defaultFetchSite` fallback. Pass directly:
 * `enrichmentProvider("llm-web", { client, fetchSite: crawl4aiFetchSite })`.
 * For tests, use `createCrawl4aiFetchSite({ fetchImpl, fallbackFetchSite })` instead so
 * nothing touches the real network.
 */
export const crawl4aiFetchSite: FetchSite = createCrawl4aiFetchSite();
