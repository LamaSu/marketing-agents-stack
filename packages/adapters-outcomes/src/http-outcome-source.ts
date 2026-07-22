/**
 * HttpOutcomeSource -- pull-style OutcomeSource over a configured ESP/CRM HTTP endpoint:
 * `GET <endpoint>?since=<iso>&limit=<n>` returning engagement events for the return leg
 * (replies/meetings/bounces). Mirrors adapters-enrichment's `crawl4aiFetchSite` injectable-
 * fetch + timeout + degrade-safe pattern (see that file's header): an injectable `fetchImpl`
 * so tests never touch the network, an AbortController-backed timeout (a hung endpoint is as
 * common a failure as connection-refused), and on ANY failure (unreachable, non-OK, timeout,
 * malformed response, even a malformed `endpoint` config) this logs a warning and resolves
 * to `[]` (or an injectable `fallback` OutcomeSource's own pull()) rather than throwing -- an
 * ingestion poll must never crash a scheduled job because one call to a third-party endpoint
 * failed. This is a deliberately STRICTER degrade posture than adapters-signals'
 * PostHogSource (which fails hard on a non-OK response): degrade-safety is this source's
 * whole reason to exist, per its design brief.
 *
 * Response contract (this package's own choice -- no canonical "ESP/CRM outcomes API" spec
 * exists the way Segment's HTTP Tracking spec does for signals): the endpoint returns JSON
 * shaped `{ "events": [ <EngagementEvent>, ... ] }` OR a bare `EngagementEvent[]` array --
 * either is accepted, matching how `segment-webhook-source.ts`'s `extractSegmentPayloads`
 * tolerates a bare object vs. `{ batch: [...] }`. Each event is mapped via the SAME
 * `outcomeFromEngagementEvent` mapper `webhook-outcome-source.ts` uses, so both sources
 * agree on engagement-type vocabulary by construction (one mapping table, not two). A single
 * unparseable event in an otherwise-good batch is skipped + warned, not fatal to the pull.
 */
import { outcomeFromEngagementEvent } from "./webhook-outcome-source.js";
import type { OutcomeSource } from "./outcome-source.js";
import { applyPullOptions } from "./util.js";
import type { Outcome, PullOptions } from "@mstack/core";

export interface HttpOutcomeSourceConfig {
  name?: string;
  /** the ESP/CRM outcomes endpoint, e.g. "https://api.example-esp.com/v1/engagement-events".
   *  Required -- unlike crawl4ai's local sidecar, there is no sensible default host for an
   *  arbitrary third-party ESP/CRM. */
  endpoint: string;
  /** extra headers, e.g. `{ authorization: "Bearer ..." }`. Never read from process.env by
   *  this package itself -- the runtime layer threads credentials through at registration
   *  time (same convention as PostHogSource/GitHubSignalSource in adapters-signals). */
  headers?: Record<string, string>;
  /** injectable fetch -- defaults to globalThis.fetch. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort the endpoint call after this many ms and degrade. Default 15000. */
  timeoutMs?: number;
  /** used on ANY fetch error (unreachable, non-OK, timeout, malformed response). Defaults to
   *  resolving `[]`. Inject another OutcomeSource (e.g. a cached SampleOutcomeSource) to
   *  degrade to something non-empty instead. */
  fallback?: OutcomeSource;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface HttpOutcomeEventsResponse {
  events?: unknown[];
}

/** Extracts the raw event payload array from either `{ events: [...] }` or a bare array. */
function extractEvents(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json !== null && typeof json === "object" && Array.isArray((json as HttpOutcomeEventsResponse).events)) {
    return (json as HttpOutcomeEventsResponse).events ?? [];
  }
  return [];
}

export class HttpOutcomeSource implements OutcomeSource {
  readonly name: string;
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #fallback: OutcomeSource | undefined;

  constructor(config: HttpOutcomeSourceConfig) {
    this.name = config.name ?? "http-outcomes";
    this.#endpoint = config.endpoint;
    this.#headers = config.headers ?? {};
    this.#fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fallback = config.fallback;
  }

  async pull(opts?: PullOptions): Promise<Outcome[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const url = new URL(this.#endpoint);
      if (opts?.since) url.searchParams.set("since", opts.since);
      if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));

      const res = await this.#fetchImpl(url.toString(), {
        headers: { accept: "application/json", ...this.#headers },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HttpOutcomeSource: GET ${url.pathname} responded ${res.status}`);
      }
      const json: unknown = await res.json();
      const events = extractEvents(json);

      const outcomes: Outcome[] = [];
      for (const event of events) {
        try {
          outcomes.push(outcomeFromEngagementEvent(event));
        } catch (err) {
          console.warn(
            `[@mstack/adapters-outcomes] HttpOutcomeSource: skipping unparseable event (${String(err)})`,
          );
        }
      }
      return applyPullOptions(outcomes, opts);
    } catch (err) {
      console.warn(
        `[@mstack/adapters-outcomes] HttpOutcomeSource: endpoint ${this.#endpoint} failed (${String(err)}); ` +
          `degrading to ${this.#fallback ? `"${this.#fallback.name}"` : "an empty result"} (degraded, not broken)`,
      );
      return this.#fallback ? this.#fallback.pull(opts) : [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convenience factory -- used by `factory.ts`'s `outcomeSource("http", config)`. Config's
 *  `endpoint` is required (no sensible zero-config default for an arbitrary third-party
 *  ESP/CRM), unlike `sampleOutcomeSource`/`webhookOutcomeSource`. */
export function httpOutcomeSource(config: HttpOutcomeSourceConfig): HttpOutcomeSource {
  return new HttpOutcomeSource(config);
}
