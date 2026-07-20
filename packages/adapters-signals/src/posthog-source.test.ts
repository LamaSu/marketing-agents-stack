import { describe, it, expect } from "vitest";
import { Signal } from "@mstack/core";

import { PostHogSource } from "./posthog-source.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PostHogSource", () => {
  it("maps PostHog events to product_usage Signals via an injected fetch (no network)", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(input.toString());
      return jsonResponse({
        results: [
          {
            id: "01ABCDEF",
            event: "docs_viewed",
            distinct_id: "usr_1",
            timestamp: "2026-07-20T12:00:00.000Z",
            properties: { page: "/docs" },
          },
        ],
      });
    };
    const source = new PostHogSource({ projectId: "123", apiKey: "phx_test", fetchImpl: fakeFetch });
    const signals = await source.pull({ limit: 10, since: "2026-07-01T00:00:00.000Z" });

    expect(signals).toHaveLength(1);
    const [signal] = signals;
    expect(() => Signal.parse(signal)).not.toThrow();
    expect(signal?.kind).toBe("product_usage");
    expect(signal?.action).toBe("docs_viewed");
    expect(signal?.actor.userId).toBe("usr_1");
    expect(signal?.id).toBe("posthog:01ABCDEF");

    expect(calls).toHaveLength(1);
    const calledUrl = new URL(calls[0] ?? "");
    expect(calledUrl.pathname).toBe("/api/projects/123/events/");
    expect(calledUrl.searchParams.get("limit")).toBe("10");
    expect(calledUrl.searchParams.get("after")).toBe("2026-07-01T00:00:00.000Z");
  });

  it("prefers person.properties.email over a top-level $email property", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        results: [
          {
            id: "e2",
            event: "feature_used",
            distinct_id: "usr_2",
            timestamp: "2026-07-20T12:00:00.000Z",
            properties: { $email: "wrong@example.com" },
            person: { properties: { email: "right@example.com" } },
          },
        ],
      });
    const source = new PostHogSource({ projectId: "1", fetchImpl: fakeFetch });
    const [signal] = await source.pull();
    expect(signal?.actor.email).toBe("right@example.com");
  });

  it("caps the requested limit at MAX_LIMIT (100)", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = input.toString();
      return jsonResponse({ results: [] });
    };
    const source = new PostHogSource({ projectId: "1", fetchImpl: fakeFetch });
    await source.pull({ limit: 5000 });
    expect(new URL(capturedUrl).searchParams.get("limit")).toBe("100");
  });

  it("throws a clear error on a non-OK response", async () => {
    const fakeFetch: typeof fetch = async () => new Response("unauthorized", { status: 401 });
    const source = new PostHogSource({ projectId: "123", fetchImpl: fakeFetch });
    await expect(source.pull()).rejects.toThrow(/401/);
  });

  it('has the name "posthog"', () => {
    const source = new PostHogSource({ projectId: "1", fetchImpl: (async () => jsonResponse({})) as typeof fetch });
    expect(source.name).toBe("posthog");
  });
});
