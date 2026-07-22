import { describe, it, expect } from "vitest";
import { Outcome } from "@mstack/core";

import { WebhookOutcomeSource, outcomeFromEngagementEvent, webhookOutcomeSource } from "./webhook-outcome-source.js";

const fixedNow = () => "2026-07-20T12:00:00.000Z";

describe("outcomeFromEngagementEvent", () => {
  it('maps a "replied" event to result:"replied"', () => {
    const outcome = outcomeFromEngagementEvent(
      { type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" },
      { now: fixedNow },
    );
    expect(() => Outcome.parse(outcome)).not.toThrow();
    expect(outcome.result).toBe("replied");
    expect(outcome.refType).toBe("draft"); // default
    expect(outcome.refId).toBe("dr_1");
  });

  it('maps a "meeting_booked" event to result:"meeting", carrying metrics through', () => {
    const outcome = outcomeFromEngagementEvent({
      type: "meeting_booked",
      refId: "dr_2",
      ts: "2026-07-02T00:00:00.000Z",
      metrics: { bookedVia: "calendly" },
    });
    expect(outcome.result).toBe("meeting");
    expect(outcome.metrics).toEqual({ bookedVia: "calendly" });
  });

  it('maps "bounced" and plain "none" events to result:"no_response"', () => {
    const bounced = outcomeFromEngagementEvent({ type: "bounced", refId: "dr_3", ts: "2026-07-03T00:00:00.000Z" });
    const none = outcomeFromEngagementEvent({ type: "none", refId: "dr_4", ts: "2026-07-03T00:00:00.000Z" });
    expect(bounced.result).toBe("no_response");
    expect(none.result).toBe("no_response");
  });

  it("is case-insensitive on the type field", () => {
    const outcome = outcomeFromEngagementEvent({ type: "REPLIED", refId: "dr_5", ts: "2026-07-04T00:00:00.000Z" });
    expect(outcome.result).toBe("replied");
  });

  it("passes through the three remaining OutcomeResult values verbatim", () => {
    expect(outcomeFromEngagementEvent({ type: "sent", refId: "dr_6", ts: "2026-07-05T00:00:00.000Z" }).result).toBe(
      "sent",
    );
    expect(
      outcomeFromEngagementEvent({
        type: "published",
        refId: "rev_1",
        refType: "review",
        ts: "2026-07-05T00:00:00.000Z",
      }).result,
    ).toBe("published");
    expect(
      outcomeFromEngagementEvent({
        type: "returned",
        refId: "rev_2",
        refType: "review",
        ts: "2026-07-05T00:00:00.000Z",
      }).result,
    ).toBe("returned");
  });

  it("throws a clear error for an unrecognized engagement type", () => {
    expect(() => outcomeFromEngagementEvent({ type: "carrier_pigeon", refId: "dr_7" })).toThrow(
      /unrecognized engagement type/,
    );
  });

  it("throws when refId is missing (zod validation)", () => {
    expect(() => outcomeFromEngagementEvent({ type: "replied" })).toThrow();
  });

  it("defaults ts to now() when absent", () => {
    const outcome = outcomeFromEngagementEvent({ type: "replied", refId: "dr_8" }, { now: fixedNow });
    expect(outcome.ts).toBe(fixedNow());
  });

  it("defaults id to a generated id when absent", () => {
    const outcome = outcomeFromEngagementEvent({ type: "replied", refId: "dr_9", ts: "2026-07-06T00:00:00.000Z" });
    expect(outcome.id.length).toBeGreaterThan(0);
  });

  it("rejects an invalid refType via the final Outcome schema check", () => {
    expect(() =>
      outcomeFromEngagementEvent({
        type: "replied",
        refId: "dr_10",
        refType: "not-a-real-reftype",
        ts: "2026-07-06T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("WebhookOutcomeSource", () => {
  it("ingests a single engagement event; pull() reads back the buffer (push-then-pull)", async () => {
    const source = new WebhookOutcomeSource({ now: fixedNow });
    const ingested = source.ingest({ type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" });
    expect(ingested).toHaveLength(1);

    const pulled = await source.pull();
    expect(pulled).toHaveLength(1);
    expect(pulled[0]?.result).toBe("replied");
  });

  it("ingests a batch (array) of engagement events in one call", async () => {
    const source = new WebhookOutcomeSource();
    const ingested = source.ingest([
      { type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" },
      { type: "meeting", refId: "dr_2", ts: "2026-07-02T00:00:00.000Z" },
    ]);
    expect(ingested).toHaveLength(2);
    expect(await source.pull()).toHaveLength(2);
    expect(source.bufferSize).toBe(2);
  });

  it("respects PullOptions.limit/since across the buffer", async () => {
    const source = new WebhookOutcomeSource();
    source.ingest([
      { type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" },
      { type: "meeting", refId: "dr_2", ts: "2026-07-10T00:00:00.000Z" },
    ]);

    expect(await source.pull({ limit: 1 })).toHaveLength(1);

    const sinceSecondOnly = await source.pull({ since: "2026-07-10T00:00:00.000Z" });
    expect(sinceSecondOnly).toHaveLength(1);
    expect(sinceSecondOnly[0]?.result).toBe("meeting");
  });

  it('has the name "webhook-outcomes" by default, overridable via config', () => {
    expect(new WebhookOutcomeSource().name).toBe("webhook-outcomes");
    expect(new WebhookOutcomeSource({ name: "sendgrid-events" }).name).toBe("sendgrid-events");
  });

  it("propagates an ingest() error for an unrecognized type without buffering it", () => {
    const source = new WebhookOutcomeSource();
    expect(() => source.ingest({ type: "smoke-signal", refId: "dr_1" })).toThrow();
    expect(source.bufferSize).toBe(0);
  });

  it("webhookOutcomeSource() factory function returns a WebhookOutcomeSource", () => {
    expect(webhookOutcomeSource()).toBeInstanceOf(WebhookOutcomeSource);
  });
});
