import { describe, it, expect } from "vitest";

import { HttpOutcomeSource, httpOutcomeSource } from "./http-outcome-source.js";
import { SampleOutcomeSource } from "./sample-outcome-source.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpOutcomeSource", () => {
  it("pulls and maps engagement events from a { events: [...] } response", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(input.toString());
      return jsonResponse({
        events: [
          { type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" },
          { type: "meeting_booked", refId: "dr_2", ts: "2026-07-02T00:00:00.000Z" },
        ],
      });
    };
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    const outcomes = await source.pull();

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.result)).toEqual(["replied", "meeting"]);
    expect(calls).toHaveLength(1);
  });

  it("accepts a bare array response body (no { events } wrapper)", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse([{ type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" }]);
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    expect(await source.pull()).toHaveLength(1);
  });

  it("sends since/limit as query params", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return jsonResponse({ events: [] });
    };
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    await source.pull({ since: "2026-07-01T00:00:00.000Z", limit: 5 });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("skips one unparseable event but keeps the rest of the batch", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        events: [
          { type: "replied", refId: "dr_1", ts: "2026-07-01T00:00:00.000Z" },
          { type: "not-a-real-type", refId: "dr_2" },
          { type: "meeting", refId: "dr_3", ts: "2026-07-03T00:00:00.000Z" },
        ],
      });
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    const outcomes = await source.pull();

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.refId)).toEqual(["dr_1", "dr_3"]);
  });

  it("degrades to an empty array (never throws) when the endpoint is unreachable", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    await expect(source.pull()).resolves.toEqual([]);
  });

  it("degrades to an empty array (never throws) on a non-OK HTTP status", async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ error: "unavailable" }, 503);
    const source = new HttpOutcomeSource({ endpoint: "https://esp.example.com/events", fetchImpl: fakeFetch });
    await expect(source.pull()).resolves.toEqual([]);
  });

  it("degrades to an injectable fallback OutcomeSource when the endpoint is unreachable", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const fallback = new SampleOutcomeSource();
    const source = new HttpOutcomeSource({
      endpoint: "https://esp.example.com/events",
      fetchImpl: fakeFetch,
      fallback,
    });
    const outcomes = await source.pull();
    const expected = await fallback.pull();

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes).toEqual(expected);
  });

  it('has the name "http-outcomes" by default, overridable via config', () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ events: [] });
    expect(new HttpOutcomeSource({ endpoint: "https://x.example.com", fetchImpl: fakeFetch }).name).toBe(
      "http-outcomes",
    );
    expect(
      new HttpOutcomeSource({ endpoint: "https://x.example.com", name: "hubspot", fetchImpl: fakeFetch }).name,
    ).toBe("hubspot");
  });

  it("httpOutcomeSource() factory function returns an HttpOutcomeSource", () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ events: [] });
    expect(httpOutcomeSource({ endpoint: "https://x.example.com", fetchImpl: fakeFetch })).toBeInstanceOf(
      HttpOutcomeSource,
    );
  });
});
