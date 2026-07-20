import { describe, it, expect } from "vitest";
import { Signal } from "@mstack/core";

import { SegmentWebhookSource, signalFromSegmentEvent } from "./segment-webhook-source.js";

const trackEvent = {
  type: "track",
  messageId: "msg_track_1",
  timestamp: "2026-07-20T12:00:00.000Z",
  userId: "usr_test_1",
  event: "docs_viewed",
  properties: { page: "/docs/quickstart" },
};

const identifyEvent = {
  type: "identify",
  messageId: "msg_identify_1",
  timestamp: "2026-07-20T12:05:00.000Z",
  userId: "usr_test_1",
  traits: { email: "test@example.com", company: "example.com", plan: "Team" },
};

describe("signalFromSegmentEvent", () => {
  it("maps a track event to a product_usage Signal", () => {
    const signal = signalFromSegmentEvent(trackEvent);
    expect(() => Signal.parse(signal)).not.toThrow();
    expect(signal.kind).toBe("product_usage");
    expect(signal.action).toBe("docs_viewed");
    expect(signal.id).toBe("msg_track_1");
    expect(signal.actor.userId).toBe("usr_test_1");
    expect(signal.properties).toEqual({ page: "/docs/quickstart" });
  });

  it("maps an identify event to an identify Signal with traits carried through", () => {
    const signal = signalFromSegmentEvent(identifyEvent);
    expect(() => Signal.parse(signal)).not.toThrow();
    expect(signal.kind).toBe("identify");
    expect(signal.actor.email).toBe("test@example.com");
    expect(signal.actor.company).toBe("example.com");
    expect(signal.traits).toEqual({ email: "test@example.com", company: "example.com", plan: "Team" });
  });

  it("maps a page event to a campaign Signal", () => {
    const signal = signalFromSegmentEvent({
      type: "page",
      userId: "usr_test_1",
      timestamp: "2026-07-20T12:10:00.000Z",
      name: "Pricing",
      properties: { url: "/pricing" },
    });
    expect(signal.kind).toBe("campaign");
    expect(signal.properties).toMatchObject({ url: "/pricing", name: "Pricing" });
  });

  it("maps a group event to a crm Signal, defaulting actor.company to groupId", () => {
    const signal = signalFromSegmentEvent({
      type: "group",
      userId: "usr_test_1",
      timestamp: "2026-07-20T12:15:00.000Z",
      groupId: "acct_figma",
      traits: { name: "Figma" },
    });
    expect(signal.kind).toBe("crm");
    expect(signal.actor.company).toBe("acct_figma");
  });

  it('throws a clear error when a "group" event has no groupId', () => {
    expect(() =>
      signalFromSegmentEvent({ type: "group", userId: "u1", timestamp: "2026-07-20T00:00:00.000Z" }),
    ).toThrow(/groupId/);
  });

  it('throws a clear error when a "track" event has no event name', () => {
    expect(() =>
      signalFromSegmentEvent({ type: "track", userId: "u1", timestamp: "2026-07-20T00:00:00.000Z" }),
    ).toThrow(/event/);
  });

  it("falls back to a generated id when messageId is absent", () => {
    const signal = signalFromSegmentEvent({ type: "track", event: "x", timestamp: "2026-07-20T00:00:00.000Z" });
    expect(signal.id.length).toBeGreaterThan(0);
  });

  it("rejects a payload with no recognized Segment type", () => {
    expect(() => signalFromSegmentEvent({ type: "alias", userId: "u1" })).toThrow();
  });
});

describe("SegmentWebhookSource", () => {
  it("ingests a single event; pull() reads back the buffer (push-then-pull)", async () => {
    const source = new SegmentWebhookSource();
    const ingested = source.ingest(trackEvent);
    expect(ingested).toHaveLength(1);

    const pulled = await source.pull();
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.id).toBe("msg_track_1");
  });

  it("ingests a Segment batch payload ({ batch: [...] })", async () => {
    const source = new SegmentWebhookSource();
    const ingested = source.ingest({ batch: [trackEvent, identifyEvent] });
    expect(ingested).toHaveLength(2);
    expect(await source.pull()).toHaveLength(2);
    expect(source.bufferSize).toBe(2);
  });

  it("respects PullOptions.limit/since across the buffer", async () => {
    const source = new SegmentWebhookSource();
    source.ingest({ batch: [trackEvent, identifyEvent] });

    expect(await source.pull({ limit: 1 })).toHaveLength(1);

    const sinceIdentifyOnly = await source.pull({ since: identifyEvent.timestamp });
    expect(sinceIdentifyOnly).toHaveLength(1);
    expect(sinceIdentifyOnly[0]?.kind).toBe("identify");
  });

  it('has the name "segment-webhook" by default, overridable via config', () => {
    expect(new SegmentWebhookSource().name).toBe("segment-webhook");
    expect(new SegmentWebhookSource({ name: "jitsu" }).name).toBe("jitsu");
  });
});
