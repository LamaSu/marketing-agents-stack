/**
 * createAntiBotFetchSite -- a clean-room, BYO (bring-your-own) anti-bot `FetchSite`
 * (see `llm-web.ts`). Rotates User-Agent (and, if a proxy-aware `fetchImpl` is
 * injected, proxy) across retries with backoff, as a free/self-managed alternative to
 * Firecrawl's hosted anti-bot handling (`./firecrawl.ts`), per
 * research/10-sota-integration-design.md §2.5 / Wave D3's "minimal BYO anti-bot/
 * proxy-rotation path in our own fetcher".
 *
 * CLEAN-ROOM: written from the task's own one-line description of the *concept*
 * (rotate identity + retry with backoff to get past basic bot defenses, then return
 * cleaned text) and from Firecrawl's public docs/README (which describe outcomes, not
 * implementation) -- never from Firecrawl's (AGPL-3.0) source, per
 * docs/build-conventions.md's "rebuild-the-concept" license boundary
 * (research/10-sota-integration-design.md §3, boundary 3). This does not claim to
 * match Firecrawl's actual capability (a real managed proxy fleet + JS rendering +
 * CAPTCHA solving) -- it's the honest free/manual tier one rung above
 * `defaultFetchSite`, for sites that reject a single static UA/IP but don't need a
 * full hosted service.
 *
 * WHY THERE IS NO BUILT-IN PROXY TRANSPORT: plain `fetch`/`RequestInit` has no
 * cross-runtime concept of an HTTP(S) proxy (Node's undici-backed `fetch` needs a
 * `ProxyAgent` dispatcher, which isn't part of the portable `typeof fetch` signature).
 * Rather than accept a `proxies` list and silently do nothing with it via plain
 * `fetch` (which would look like proxying works when it doesn't -- dishonest), this
 * module owns the part that IS genuinely ours to build and test -- rotation, retry
 * count, and backoff -- and exposes the chosen proxy for a given attempt to an
 * INJECTABLE `fetchImpl` via its own minimal `AntiBotFetchImpl` contract. A caller who
 * wants real proxied transport injects a `fetchImpl` that honors `proxy` (e.g. wraps an
 * undici `ProxyAgent`). The default `fetchImpl` does a plain direct fetch and rotates
 * only the `User-Agent` header -- which genuinely works with zero extra plumbing.
 *
 * LOWEST TRUST, UNCHANGED TRUST ORDER: same as `firecrawlFetchSite` -- this only
 * changes fetch *delivery*, never the `EnrichmentRecord.source` that
 * `mergeEnrichment`'s `registry > llm-web > paid` order ranks by.
 */
import { defaultFetchSite, type FetchSite } from "./llm-web.js";

/** What a per-attempt fetch call receives. `proxy` is a pass-through value -- plain
 *  `fetch` cannot honor it; a custom `fetchImpl` that wraps a proxy-aware HTTP client
 *  can. See the file header for why this isn't just `typeof fetch`. */
export interface AntiBotAttemptInit {
  headers: Record<string, string>;
  /** the proxy URL selected for this attempt, or undefined if no `proxies` were
   *  configured (or the list is empty). */
  proxy: string | undefined;
  signal: AbortSignal;
}
export type AntiBotFetchImpl = (url: string, init: AntiBotAttemptInit) => Promise<Response>;

/** A handful of realistic desktop browser User-Agent strings, used only when the
 *  caller doesn't supply their own `userAgents` list. Rotating even just this,
 *  without any proxy at all, is a real (if modest) improvement over a single static
 *  UA -- the honest baseline this module can offer for free. */
const DEFAULT_USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AntiBotFetchSiteConfig {
  /** Proxy URLs to rotate through, one per attempt (cycled with `%`). Empty/omitted
   *  means every attempt goes direct (`proxy: undefined`) -- only the User-Agent
   *  rotates. Actually routing traffic through these is the injected `fetchImpl`'s
   *  job; see the file header. */
  proxies?: string[];
  /** User-Agent strings to rotate through, one per attempt (cycled with `%`). Defaults
   *  to `DEFAULT_USER_AGENTS`. */
  userAgents?: string[];
  /** total attempts before giving up and falling back. Default 3. */
  retries?: number;
  /** base backoff between attempts in ms; attempt N waits `backoffMs * N` (linear
   *  backoff -- simple and sufficient for a bounded small retry count). Default 250.
   *  Set to 0 for instant retries (e.g. in tests). */
  backoffMs?: number;
  /** abort an individual attempt after this many ms. Default 10000. */
  timeoutMs?: number;
  /** how a single attempt is actually made. Defaults to a plain direct
   *  `globalThis.fetch(url, { headers, signal })` (ignores `proxy` -- see file
   *  header). Inject your own to add real proxy transport, or a fake in tests. */
  fetchImpl?: AntiBotFetchImpl;
  /** used when every attempt is exhausted. Defaults to `defaultFetchSite` -- degraded,
   *  never broken, exactly like every other seam default in this package. Injectable
   *  so tests can observe the fallback without hitting the real network. */
  fallbackFetchSite?: FetchSite;
}

/** Minimal HTML->text cleanup, deliberately the same rough shape as `llm-web.ts`'s
 *  `defaultFetchSite` strip (this module doesn't do content-quality extraction --
 *  that's `crawl4aiFetchSite`'s or `firecrawlFetchSite`'s job -- it only gets past
 *  basic bot defenses and hands back readable-enough text). */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

const defaultFetchImpl: AntiBotFetchImpl = async (url, { headers, signal }) => {
  return globalThis.fetch(url, { headers, signal });
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a `FetchSite` that rotates User-Agent + proxy across up to `retries` attempts,
 * with linear backoff between them. Returns cleaned text from the first attempt that
 * both succeeds (2xx) and yields non-empty content; if every attempt fails, logs a
 * warning and calls `fallbackFetchSite` (default `defaultFetchSite`) -- degraded, never
 * broken.
 */
export function createAntiBotFetchSite(config: AntiBotFetchSiteConfig = {}): FetchSite {
  const proxies = config.proxies ?? [];
  const userAgents = config.userAgents && config.userAgents.length > 0 ? config.userAgents : DEFAULT_USER_AGENTS;
  const retries = config.retries ?? DEFAULT_RETRIES;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? defaultFetchImpl;
  const fallbackFetchSite = config.fallbackFetchSite ?? defaultFetchSite;

  const effectiveRetries = Math.max(1, retries);

  return async (url: string): Promise<string> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < effectiveRetries; attempt++) {
      const proxy = proxies.length > 0 ? proxies[attempt % proxies.length] : undefined;
      const userAgent = userAgents[attempt % userAgents.length] ?? DEFAULT_USER_AGENTS[0] ?? "Mozilla/5.0";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          headers: { "User-Agent": userAgent },
          proxy,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(
            `anti-bot fetch attempt ${attempt + 1}/${effectiveRetries} -- ${url} responded ${res.status}`,
          );
        }
        const html = await res.text();
        const text = stripHtml(html);
        if (!text) {
          throw new Error(`anti-bot fetch attempt ${attempt + 1}/${effectiveRetries} -- ${url} returned empty content`);
        }
        return text;
      } catch (err) {
        lastErr = err;
        if (attempt < effectiveRetries - 1) await sleep(backoffMs * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }

    console.warn(
      `[@mstack/adapters-enrichment] antiBotFetchSite: all ${effectiveRetries} attempt(s) failed for ${url} ` +
        `(last error: ${String(lastErr)}); falling back to defaultFetchSite (degraded, not broken)`,
    );
    return fallbackFetchSite(url);
  };
}
