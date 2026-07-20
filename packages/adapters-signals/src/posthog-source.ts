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
 * FLAG FOR SPARK: the exact `/events/` response shape (`results[]`, `after`/`before` params) is
 * asserted from PostHog's public API docs, not verified against a live project -- confirm
 * before depending on it for a real ingest run.
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
}

const DEFAULT_HOST = "https://app.posthog.com";
// Conservative, not a confirmed PostHog API ceiling -- see the Spark-verify note above.
const MAX_LIMIT = 100;

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

export class PostHogSource implements SignalSource {
  readonly name: string;
  readonly #projectId: string;
  readonly #apiKey: string | undefined;
  readonly #host: string;
  readonly #fetchImpl: typeof fetch;
  readonly #defaultLimit: number;

  constructor(config: PostHogSourceConfig) {
    this.name = config.name ?? "posthog";
    this.#projectId = config.projectId;
    this.#apiKey = config.apiKey;
    this.#host = (config.host ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#defaultLimit = config.defaultLimit ?? 50;
  }

  async pull(opts?: PullOptions): Promise<Signal[]> {
    const requested = opts?.limit ?? this.#defaultLimit;
    const limit = Math.min(requested, MAX_LIMIT);

    const url = new URL(`${this.#host}/api/projects/${this.#projectId}/events/`);
    url.searchParams.set("limit", String(limit));
    const since = opts?.since;
    if (since) url.searchParams.set("after", since);

    const headers: Record<string, string> = { accept: "application/json" };
    const apiKey = this.#apiKey;
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const res = await this.#fetchImpl(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PostHogSource: GET ${url.pathname} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as PostHogEventsResponse;
    return (payload.results ?? []).map(mapPostHogEvent);
  }
}
