/**
 * WebhookOutcomeSource -- push-style OutcomeSource for engagement events from an ESP/CRM:
 * a reply landed, a meeting got booked, a message bounced. This is the return-leg
 * counterpart to adapters-signals' SegmentWebhookSource (same push-then-pull shape), but
 * there is no single industry-standard "ESP webhook spec" the way there is for Segment's
 * HTTP Tracking API -- every ESP/CRM (SendGrid, Mailgun, Postmark, HubSpot, Instantly, ...)
 * ships its own webhook payload shape. So this file defines ONE small, neutral
 * `EngagementEvent` shape this package owns, and a real integration's webhook route handler
 * is expected to translate its provider's native payload into this shape before calling
 * `ingest()` (a thin per-provider translation, not zero-code like Segment -- there is no
 * spec to piggyback on here). `outcomeFromEngagementEvent` is the pure mapper (payload ->
 * Outcome) and can be used standalone (e.g. directly from `HttpOutcomeSource`, which reuses
 * it below); `WebhookOutcomeSource` wraps it to satisfy the `OutcomeSource` seam, the same
 * way `SegmentWebhookSource` wraps `signalFromSegmentEvent`.
 *
 * Mapping (the only lossy step -- everything else is pass-through): an ESP/CRM's own event
 * vocabulary is collapsed onto `@mstack/core`'s fixed 6-value `OutcomeResult` enum
 * (sent|replied|meeting|published|returned|no_response) via ENGAGEMENT_TYPE_MAP below --
 * email replied -> "replied", meeting booked -> "meeting", bounce/unsubscribe/no-signal ->
 * "no_response", plus direct pass-through for the other three enum values (sent/published/
 * returned) for a producer that already speaks our vocabulary. An unrecognized `type` throws
 * a clear Error rather than silently guessing -- same failure posture as
 * `signalFromSegmentEvent` on an unhandled Segment type.
 */
import { newId, nowIso, Outcome } from "@mstack/core";
import type { OutcomeResult, PullOptions } from "@mstack/core";
import { z } from "zod";

import type { OutcomeSource } from "./outcome-source.js";
import { applyPullOptions } from "./util.js";

/**
 * The neutral engagement-event shape this package accepts. `refId` is required (which
 * draft/decision/review this event is ABOUT); `refType` defaults to "draft" -- the common
 * case, since replies/meetings/bounces are almost always reacting to a dispatched outreach
 * Draft. `refType` is validated loosely here (any string) and checked against the REAL
 * `Outcome.refType` enum only at the final `Outcome.parse` in `outcomeFromEngagementEvent`
 * below -- this avoids duplicating (and risking drift from) the authoritative enum in
 * `@mstack/core`'s schemas.ts. `type` is likewise a plain string (validated against
 * ENGAGEMENT_TYPE_MAP at map time, not baked into this zod schema) so a caller integrating a
 * new provider can add a synonym to the map without a schema change here.
 */
export const EngagementEvent = z.object({
  type: z.string(),
  refId: z.string(),
  refType: z.string().optional(),
  id: z.string().optional(),
  ts: z.string().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});
export type EngagementEvent = z.infer<typeof EngagementEvent>;

/**
 * ESP/CRM engagement-event vocabulary -> `OutcomeResult`. Covers the three core cases
 * (reply/meeting/bounce-or-none) plus direct pass-through of the other three
 * `OutcomeResult` values for a producer that already speaks our vocabulary. Keys are
 * lower-cased before lookup so "Replied"/"REPLIED" match the same entry.
 */
const ENGAGEMENT_TYPE_MAP: Readonly<Record<string, OutcomeResult>> = {
  // email replied
  replied: "replied",
  reply: "replied",
  email_replied: "replied",
  // meeting booked
  meeting: "meeting",
  meeting_booked: "meeting",
  meeting_scheduled: "meeting",
  // bounce / unsubscribe / explicit no-signal
  bounced: "no_response",
  bounce: "no_response",
  unsubscribed: "no_response",
  no_response: "no_response",
  none: "no_response",
  // pass-through for the remaining OutcomeResult values
  sent: "sent",
  published: "published",
  returned: "returned",
};

function mapEngagementType(type: string): OutcomeResult {
  const mapped = ENGAGEMENT_TYPE_MAP[type.toLowerCase()];
  if (!mapped) {
    throw new Error(
      `outcomeFromEngagementEvent: unrecognized engagement type "${type}" -- add it to ` +
        `ENGAGEMENT_TYPE_MAP (webhook-outcome-source.ts) if this is a new provider synonym`,
    );
  }
  return mapped;
}

/**
 * Maps ONE validated engagement event to a core Outcome. Pure -- no I/O, no buffering.
 * `id` defaults to a generated one when the provider payload doesn't carry a stable event
 * id; `ts` defaults to now (an injectable clock keeps this testable/deterministic). Throws
 * if `type` doesn't map to a known `OutcomeResult`, or if the final `Outcome.parse` rejects
 * the shape (e.g. an invalid `refType`).
 */
export function outcomeFromEngagementEvent(payload: unknown, opts: { now?: () => string } = {}): Outcome {
  const event = EngagementEvent.parse(payload);
  const now = opts.now ?? nowIso;
  return Outcome.parse({
    id: event.id ?? newId("out"),
    refType: event.refType ?? "draft",
    refId: event.refId,
    result: mapEngagementType(event.type),
    metrics: event.metrics,
    ts: event.ts ?? now(),
  });
}

export interface WebhookOutcomeSourceConfig {
  name?: string;
  /** injectable clock; tests only. Passed through to `outcomeFromEngagementEvent`. */
  now?: () => string;
}

export class WebhookOutcomeSource implements OutcomeSource {
  readonly name: string;
  readonly #now: (() => string) | undefined;
  #buffer: Outcome[] = [];

  constructor(config: WebhookOutcomeSourceConfig = {}) {
    this.name = config.name ?? "webhook-outcomes";
    this.#now = config.now;
  }

  /** Call this from your ESP/CRM webhook route handler on every inbound POST (after
   *  translating the provider's native payload into `EngagementEvent` shape). Accepts
   *  either a single event object or an array of them (many ESP webhooks batch multiple
   *  engagement events per POST). Validates + maps + buffers each; returns exactly the
   *  Outcome(s) just ingested. Throws (and buffers NOTHING from this call) on an
   *  unrecognized `type` or a payload missing `refId` -- a clear 4xx-worthy error for the
   *  route handler to catch. */
  ingest(payload: unknown): Outcome[] {
    const events = Array.isArray(payload) ? payload : [payload];
    const outcomes = events.map((event) => outcomeFromEngagementEvent(event, { now: this.#now }));
    this.#buffer.push(...outcomes);
    return outcomes;
  }

  /** OutcomeSource seam. A push-style source has nothing to fetch from the network; pull()
   *  reads back what ingest() has buffered so far, so callers can treat every source the
   *  same way. */
  async pull(opts?: PullOptions): Promise<Outcome[]> {
    return applyPullOptions(this.#buffer, opts);
  }

  /** Ops/test helper -- current buffer size, no mutation. */
  get bufferSize(): number {
    return this.#buffer.length;
  }
}

/** Convenience factory -- used by `factory.ts`'s `outcomeSource("webhook", config)`. */
export function webhookOutcomeSource(config?: WebhookOutcomeSourceConfig): WebhookOutcomeSource {
  return new WebhookOutcomeSource(config);
}
