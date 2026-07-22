/**
 * PostHogSource -- pull-style SignalSource over PostHog's REST Events API
 * (`GET /api/projects/:id/events/`), the product-usage connector (research/tools/
 * A-signals-ingestion.md: "PostHog -- ADOPT as the product-usage connector").
 *
 * DESIGN NOTE (why fetch, not the posthog-node SDK, for the PULL path): posthog-node is a
 * capture/write-oriented SDK (capture/identify/alias/featureFlags) -- it does not expose a
 * stable public method for reading events back, which is what this adapter needs. PostHog's
 * REST Events API is the documented way to read events back, so that's what this class calls,
 * via an injectable `fetchImpl` (same pattern as packages/credentials' LocalBroker) so tests
 * never touch the network. `posthog-node` is still a declared dependency of this package per
 * the research file's verdict, for the natural companion use case (a real capture-side
 * integration elsewhere in the stack) -- just not imported by this pull adapter.
 *
 * HARDENING (v0.2): Pagination over PostHog's `next` cursor (opt-in via enablePagination)
 * and bounded exponential backoff on HTTP 429 (rate-limit) are now implemented. Pagination
 * is opt-in/keyed to preserve behavior when unconfigured. Both use the injectable `fetchImpl`
 * so tests remain fully offline.
 *
 * FLAG FOR SPARK: the exact `/events/` response shape (`results[]`, `next`, `after`/`before`
 * params) is asserted from PostHog's public API docs, not verified against a live project --
 * confirm before depending on it for a real ingest run.
 */
import { Signal } from "@mstack/core";
import type { PullOptions, SignalSource } from "@mstack/core";

import { asString } from "./util.js";

export interface PostHogSourceConfig {
  name?: string;
  /** PostHog project id events are pulled from. */
  projectId: string;
  /** Personal API key (read scope) -- see https://posthog.com/docs/api/overview.
   *  Optional: an unauthenticated call will simply 401/403 against a private project. */
  apiKey?: string;
  /** defaults to PostHog US cloud; self-hosted/EU deployments override. */
  host?: string;
  /** injectable HTTP client so tests never hit the network. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** events requested per pull when PullOptions.limit is not given. */
  defaultLimit?: number;
  /**
   * Enable pagination across PostHog's `next` cursor. When true, follows the `next` URL
   * until exhausted or the limit is reached. Opt-in to preserve current behavior when
   * unconfigured. Defaults to false.
   */
  enablePagination?: boolean;
  /**
   * Max retries for rate-limit (HTTP 429) responses. Defaults to 3. Set to 0 to disable.
   * Respects Retry-After header if present, otherwise uses bounded exponential backoff
   * (2^attempt seconds, capped at 60 seconds).
   */
  maxRateLimitRetries?: number;
}

interface PostHogEventRow {
  id: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties?: Record<string, unknown>;
  person?: { properties?: Record<string, unknown> } | null;
}

interface PostHogEventsResponse {
  results?: PostHogEventRow[];
  /** Pagination cursor for fetching the next page of results. */
  next?: string | null;
}

const DEFAULT_HOST = "https://app.posthog.com";
// Conservative, not a confirmed PostHog API ceiling -- see the Spark-verify note above.
const MAX_LIMIT = 100;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
const MAX_BACKOFF_SECONDS = 60;

function mapPostHogEvent(row: PostHogEventRow): Signal {
  const personProps = row.person?.properties ?? {};
  return Signal.parse({
    id: `posthog:${row.id}`,
    ts: row.timestamp,
    source: "posthog",
    kind: "product_usage",
    actor: {
      userId: row.distinct_id,
      email: asString(personProps["email"] ?? row.properties?.["$email"]),
      company: asString(personProps["company"] ?? row.properties?.["company"]),
    },
    action: row.event,
    properties: row.properties,
    raw: row,
  });
}

/**
 * Sleep for a given number of milliseconds. Used for rate-limit backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate backoff delay in milliseconds for a given retry attempt.
 * Uses exponential backoff: 2^attempt seconds, capped at MAX_BACKOFF_SECONDS.
 */
function calculateBackoffMs(attempt: number): number {
  const seconds = Math.min(Math.pow(2, attempt), MAX_BACKOFF_SECONDS);
  return seconds * 1000;
}

export class PostHogSource implements SignalSource {
  readonly name: string;
  readonly #projectId: string;
  readonly #apiKey: string | undefined;
  readonly #host: string;
  readonly #fetchImpl: typeof fetch;
  readonly #defaultLimit: number;
  readonly #enablePagination: boolean;
  readonly #maxRateLimitRetries: number;

  constructor(config: PostHogSourceConfig) {
    this.name = config.name ?? "posthog";
    this.#projectId = config.projectId;
    this.#apiKey = config.apiKey;
    this.#host = (config.host ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#defaultLimit = config.defaultLimit ?? 50;
    this.#enablePagination = config.enablePagination ?? false;
    this.#maxRateLimitRetries = config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  }

  /**
   * Fetch a single page from PostHog, with rate-limit retry logic.
   * Returns the parsed response or throws on non-429 errors.
   */
  async #fetchWithRetry(url: string, headers: Record<string, string>): Promise<PostHogEventsResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.#maxRateLimitRetries; attempt++) {
      const res = await this.#fetchImpl(url, { headers });

      if (res.ok) {
        return (await res.json()) as PostHogEventsResponse;
      }

      if (res.status === 429 && attempt < this.#maxRateLimitRetries) {
        // Extract Retry-After header if present, otherwise use exponential backoff
        const retryAfter = res.headers.get("retry-after");
        let delayMs: number;

        if (retryAfter) {
          // Retry-After can be a number (seconds) or an HTTP-date
          const parsed = parseInt(retryAfter, 10);
          delayMs = isNaN(parsed) ? calculateBackoffMs(attempt) : parsed * 1000;
        } else {
          delayMs = calculateBackoffMs(attempt);
        }

        await sleep(delayMs);
        continue;
      }

      // Non-429 error or max retries reached
      const body = await res.text().catch(() => "");
      lastError = new Error(
        `PostHogSource: GET ${new URL(url).pathname} failed (${res.status}): ${body.slice(0, 300)}`
      );
      throw lastError;
    }

    throw lastError ?? new Error("PostHogSource: unexpected retry loop exit");
  }

  async pull(opts?: PullOptions): Promise<Signal[]> {
    const requested = opts?.limit ?? this.#defaultLimit;
    const pageLimit = Math.min(requested, MAX_LIMIT);
    const totalLimit = requested; // for pagination, we track the total requested across all pages

    const url = new URL(`${this.#host}/api/projects/${this.#projectId}/events/`);
    url.searchParams.set("limit", String(pageLimit));
    const since = opts?.since;
    if (since) url.searchParams.set("after", since);

    const headers: Record<string, string> = { accept: "application/json" };
    const apiKey = this.#apiKey;
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const allSignals: Signal[] = [];
    let nextUrl: string | null | undefined = url.toString();
    let fetched = 0;

    while (nextUrl && fetched < totalLimit) {
      const payload = await this.#fetchWithRetry(nextUrl, headers);
      const pageResults = payload.results ?? [];
      allSignals.push(...pageResults.map(mapPostHogEvent));
      fetched += pageResults.length;

      // If pagination is disabled or there's no next link, stop here
      if (!this.#enablePagination || !payload.next) {
        break;
      }

      // For subsequent requests, construct the next URL if it's a relative path
      nextUrl = payload.next.startsWith("http") ? payload.next : `${this.#host}${payload.next}`;
    }

    // Trim results to the original limit if we fetched more across multiple pages
    return allSignals.slice(0, totalLimit);
  }
}
