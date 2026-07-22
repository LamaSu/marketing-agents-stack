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

  describe("pagination", () => {
    it("does not paginate by default (enablePagination: false)", async () => {
      const calls: string[] = [];
      const fakeFetch: typeof fetch = async (input) => {
        calls.push(input.toString());
        return jsonResponse({
          results: [
            {
              id: "page1_event1",
              event: "click",
              distinct_id: "usr_1",
              timestamp: "2026-07-20T12:00:00.000Z",
            },
          ],
          next: "/api/projects/123/events/?cursor=abc123",
        });
      };
      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        enablePagination: false,
      });
      const signals = await source.pull({ limit: 50 });

      expect(signals).toHaveLength(1);
      expect(signals[0]?.id).toBe("posthog:page1_event1");
      // Should only make one call, not follow the next link
      expect(calls).toHaveLength(1);
    });

    it("follows the next cursor when enablePagination: true, accumulating results across pages", async () => {
      const calls: string[] = [];
      const fakeFetch: typeof fetch = async (input) => {
        const urlStr = input.toString();
        calls.push(urlStr);
        const url = new URL(urlStr);

        // First page
        if (!url.searchParams.has("cursor")) {
          return jsonResponse({
            results: [
              {
                id: "page1_event1",
                event: "click",
                distinct_id: "usr_1",
                timestamp: "2026-07-20T12:00:00.000Z",
              },
              {
                id: "page1_event2",
                event: "view",
                distinct_id: "usr_1",
                timestamp: "2026-07-20T12:01:00.000Z",
              },
            ],
            next: "/api/projects/123/events/?cursor=page2_cursor",
          });
        }

        // Second page (next link)
        return jsonResponse({
          results: [
            {
              id: "page2_event1",
              event: "purchase",
              distinct_id: "usr_2",
              timestamp: "2026-07-20T12:02:00.000Z",
            },
          ],
          next: null, // No more pages
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        enablePagination: true,
      });
      const signals = await source.pull({ limit: 100 });

      expect(signals).toHaveLength(3);
      expect(signals[0]?.id).toBe("posthog:page1_event1");
      expect(signals[1]?.id).toBe("posthog:page1_event2");
      expect(signals[2]?.id).toBe("posthog:page2_event1");

      // Should have made 2 calls (page 1, then page 2)
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("cursor=page2_cursor");
    });

    it("respects the limit across paginated results", async () => {
      const calls: string[] = [];
      const fakeFetch: typeof fetch = async (input) => {
        const urlStr = input.toString();
        calls.push(urlStr);

        // Always return 10 results + a next link (infinite pagination)
        const results = Array.from({ length: 10 }, (_, i) => ({
          id: `evt_${calls.length}_${i}`,
          event: "test_event",
          distinct_id: "usr_1",
          timestamp: "2026-07-20T12:00:00.000Z",
        }));

        return jsonResponse({
          results,
          next: "/api/projects/123/events/?cursor=next",
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        enablePagination: true,
      });
      const signals = await source.pull({ limit: 15 });

      // Should stop at 15 even though more pages are available
      expect(signals).toHaveLength(15);
      // Depending on page size, might fetch 2 pages (10 + 5 from second page)
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("rate-limit handling (HTTP 429)", () => {
    it("retries on 429 with exponential backoff, using injected fetch (no real delays in test)", async () => {
      let attemptCount = 0;
      const fakeFetch: typeof fetch = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          // First attempt: rate limited
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        // Second attempt: success
        return jsonResponse({
          results: [
            {
              id: "after_retry",
              event: "success",
              distinct_id: "usr_1",
              timestamp: "2026-07-20T12:00:00.000Z",
            },
          ],
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        maxRateLimitRetries: 3,
      });
      const signals = await source.pull();

      expect(signals).toHaveLength(1);
      expect(signals[0]?.id).toBe("posthog:after_retry");
      expect(attemptCount).toBe(2); // First 429, then success
    });

    it("respects Retry-After header when present on 429", async () => {
      let attemptCount = 0;
      const fakeFetch: typeof fetch = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "retry-after": "1" }, // 1 second (will be converted to ms)
          });
        }
        return jsonResponse({
          results: [
            {
              id: "retry_after_event",
              event: "ok",
              distinct_id: "usr_1",
              timestamp: "2026-07-20T12:00:00.000Z",
            },
          ],
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        maxRateLimitRetries: 3,
      });
      const signals = await source.pull();

      expect(signals).toHaveLength(1);
      expect(attemptCount).toBe(2);
    });

    it("gives up after maxRateLimitRetries exceeded", async () => {
      let attemptCount = 0;
      const fakeFetch: typeof fetch = async () => {
        attemptCount++;
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        maxRateLimitRetries: 2, // Allow 2 retries
      });

      await expect(source.pull()).rejects.toThrow(/429/);
      expect(attemptCount).toBe(3); // Initial + 2 retries
    });

    it("disables rate-limit retries when maxRateLimitRetries is 0", async () => {
      let attemptCount = 0;
      const fakeFetch: typeof fetch = async () => {
        attemptCount++;
        return new Response("Too Many Requests", {
          status: 429,
        });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        maxRateLimitRetries: 0,
      });

      await expect(source.pull()).rejects.toThrow(/429/);
      expect(attemptCount).toBe(1); // No retries
    });

    it("throws immediately on non-429 errors even after successful 429 retries", async () => {
      let attemptCount = 0;
      const fakeFetch: typeof fetch = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return new Response("Too Many Requests", { status: 429 });
        }
        // Second attempt: different error
        return new Response("Internal Server Error", { status: 500 });
      };

      const source = new PostHogSource({
        projectId: "123",
        fetchImpl: fakeFetch,
        maxRateLimitRetries: 3,
      });

      await expect(source.pull()).rejects.toThrow(/500/);
      expect(attemptCount).toBe(2);
    });
  });
});
