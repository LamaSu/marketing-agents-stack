/**
 * SegmentWebhookSource -- push-style SignalSource for the Segment HTTP Tracking spec
 * (identify/track/page/group; batch supported). Zero SDK needed to receive it: any producer
 * that speaks the spec -- Jitsu (MIT), RudderStack, Segment itself, OpenSnowcat -- can POST
 * into whatever HTTP route wraps `ingest()`. See research/tools/A-signals-ingestion.md
 * ("Warehouse-native / webhook capture + the Segment HTTP spec").
 *
 * `signalFromSegmentEvent` is the pure mapper (payload -> Signal) and can be used standalone
 * (e.g. straight from an HTTP route handler) without the class at all. `SegmentWebhookSource`
 * wraps it to satisfy the `SignalSource` seam: `ingest()` is what your webhook route calls on
 * each inbound POST (normalizes + buffers), and `pull()` -- the seam method -- reads back
 * whatever has been ingested so far. This is what lets a push-style source share ONE interface
 * with the pull-style adapters in this package: the memory writer / chorus step calling
 * `source.pull()` never needs to know which kind of source it's talking to.
 */
import { newId, nowIso, Signal } from "@mstack/core";
import type { PullOptions, SignalSource } from "@mstack/core";
import { z } from "zod";

import { applyPullOptions, asString } from "./util.js";

/**
 * Deliberately permissive (only `type` is required): real-world webhook bodies from different
 * Segment-spec producers vary slightly, and the spec itself doesn't mandate every field on
 * every call. `signalFromSegmentEvent` enforces the couple of fields that are genuinely
 * required PER call type (e.g. `track` needs `event`) with a clear thrown Error, rather than
 * baking that into a stricter discriminated-union zod schema that would reject an otherwise-
 * valid payload over a field we don't even read.
 */
export const SegmentEvent = z.object({
  type: z.enum(["identify", "track", "page", "group"]),
  messageId: z.string().optional(),
  timestamp: z.string().optional(),
  receivedAt: z.string().optional(),
  userId: z.string().optional(),
  anonymousId: z.string().optional(),
  event: z.string().optional(), // track
  name: z.string().optional(), // page
  groupId: z.string().optional(), // group
  traits: z.record(z.string(), z.unknown()).optional(), // identify + group
  properties: z.record(z.string(), z.unknown()).optional(), // track + page
});
export type SegmentEvent = z.infer<typeof SegmentEvent>;

export const SegmentBatch = z.object({
  batch: z.array(SegmentEvent),
});
export type SegmentBatch = z.infer<typeof SegmentBatch>;

/**
 * Extracts 1+ RAW (still-unvalidated) Segment-event payloads from an inbound webhook body:
 * either `{ batch: [...] }` or a single event object. Deliberately duck-types the `batch` check
 * here instead of `SegmentBatch.parse(body)` -- parsing here would validate+strip each batch
 * item before `signalFromSegmentEvent` sees it, and that function stamps `Signal.raw` from the
 * payload it receives, so a pre-parsed item would lose the audit fidelity `raw` is for. Each
 * item this returns is still individually validated inside `signalFromSegmentEvent`.
 */
function extractSegmentPayloads(body: unknown): unknown[] {
  if (body !== null && typeof body === "object" && Array.isArray((body as { batch?: unknown }).batch)) {
    return (body as { batch: unknown[] }).batch;
  }
  return [body];
}

/**
 * Maps ONE validated Segment-spec event to a core Signal. Pure -- no I/O, no buffering.
 *
 * Segment "type" -> our Signal.kind. The Segment spec has no notion of "kind" -- this mapping
 * is our own design choice, chosen to match how the bundled data/signals.sample.jsonl fixture
 * already uses these pairings (see data/README.md):
 *   identify -> "identify"       verbatim; SignalKind has a matching value
 *   track    -> "product_usage"  a track call ("an action a user took") is the same shape as
 *                                 PostHogSource's events, our other product_usage source
 *   page     -> "campaign"       matches the fixture: source:"segment" + page-view-shaped
 *                                 actions (pricing_page_viewed, case_study_viewed, ...) are
 *                                 all kind:"campaign"
 *   group    -> "crm"            associating a user with an org/account is a CRM-shaped op
 */
export function signalFromSegmentEvent(payload: unknown): Signal {
  const event = SegmentEvent.parse(payload);
  const ts = event.timestamp ?? event.receivedAt ?? nowIso();
  const id = event.messageId ?? newId("sig");

  const actor: Signal["actor"] = {
    userId: event.userId,
    anonId: event.anonymousId,
    email: asString(event.traits?.["email"]),
    company:
      asString(event.traits?.["company"] ?? event.traits?.["companyName"]) ??
      (event.type === "group" ? event.groupId : undefined),
    handle: asString(event.traits?.["username"] ?? event.traits?.["handle"]),
  };
  const base = { id, ts, source: "segment-webhook", actor, raw: payload };

  switch (event.type) {
    case "identify":
      return Signal.parse({ ...base, kind: "identify", action: "identify", traits: event.traits });
    case "track": {
      if (!event.event) {
        throw new Error('signalFromSegmentEvent: "track" events require a non-empty "event" field');
      }
      return Signal.parse({ ...base, kind: "product_usage", action: event.event, properties: event.properties });
    }
    case "page":
      return Signal.parse({
        ...base,
        kind: "campaign",
        action: "page_viewed",
        properties: { ...event.properties, name: event.name },
      });
    case "group": {
      if (!event.groupId) {
        throw new Error('signalFromSegmentEvent: "group" events require a non-empty "groupId" field');
      }
      return Signal.parse({
        ...base,
        kind: "crm",
        action: "group_associated",
        traits: event.traits,
        properties: { groupId: event.groupId },
      });
    }
    default: {
      const exhaustive: never = event.type;
      throw new Error(`signalFromSegmentEvent: unhandled Segment event type "${String(exhaustive)}"`);
    }
  }
}

export interface SegmentWebhookSourceConfig {
  name?: string;
}

export class SegmentWebhookSource implements SignalSource {
  readonly name: string;
  #buffer: Signal[] = [];

  constructor(config: SegmentWebhookSourceConfig = {}) {
    this.name = config.name ?? "segment-webhook";
  }

  /** Call this from your webhook route handler on every inbound POST. Validates + maps +
   *  buffers; returns exactly the Signal(s) just ingested. Throws if any event/batch item
   *  fails validation (a clear 4xx-worthy error for the route handler to catch). */
  ingest(body: unknown): Signal[] {
    const payloads = extractSegmentPayloads(body);
    const signals = payloads.map((p) => signalFromSegmentEvent(p));
    this.#buffer.push(...signals);
    return signals;
  }

  /** SignalSource seam. A push-style source has nothing to fetch from the network; pull() reads
   *  back what ingest() has buffered so far, so callers can treat every source the same way. */
  async pull(opts?: PullOptions): Promise<Signal[]> {
    return applyPullOptions(this.#buffer, opts);
  }

  /** Ops/test helper -- current buffer size, no mutation. */
  get bufferSize(): number {
    return this.#buffer.length;
  }
}
