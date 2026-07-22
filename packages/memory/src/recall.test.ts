import { describe, it, expect, vi } from "vitest";
import { noopRecallProvider, createGraphitiRecall } from "./recall.js";
import type { RecallHit } from "./recall.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("noopRecallProvider (the default)", () => {
  it("returns [] — recall is optional; the warehouse is the source of record", async () => {
    expect(await noopRecallProvider.recall("acc_1", "anything")).toEqual([]);
  });
});

describe("createGraphitiRecall (opt-in sidecar)", () => {
  it("POSTs {accountId, query} to /search and maps hits", async () => {
    const fetchImpl = fakeFetch(200, {
      hits: [
        { id: "h1", text: "Bought the enterprise plan in Q2", score: 0.9, source: "crm", ts: "2026-04-01" },
        { id: "h2", fact: "Champion left the company", similarity: 0.7 },
      ],
    });
    const provider = createGraphitiRecall({ baseUrl: "http://sidecar.local:8002/", fetchImpl });

    const hits = await provider.recall("acc_1", "recent history");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://sidecar.local:8002/search");
    expect(JSON.parse(String(init.body))).toEqual({ accountId: "acc_1", query: "recent history" });
    expect(hits).toEqual<RecallHit[]>([
      { id: "h1", text: "Bought the enterprise plan in Q2", score: 0.9, source: "crm", ts: "2026-04-01" },
      { id: "h2", text: "Champion left the company", score: 0.7 },
    ]);
  });

  it("tolerates alternate array keys (results/facts) and drops empty-text hits", async () => {
    const provider = createGraphitiRecall({
      fetchImpl: fakeFetch(200, { results: [{ id: "a", content: "x" }, { id: "b", text: "  " }] }),
    });
    const hits = await provider.recall("acc_1", "q");
    expect(hits).toEqual([{ id: "a", text: "x", score: 0 }]);
  });

  it("respects the limit", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, text: `fact ${i}`, score: 0.5 }));
    const provider = createGraphitiRecall({ limit: 3, fetchImpl: fakeFetch(200, { hits: many }) });
    expect(await provider.recall("acc_1", "q")).toHaveLength(3);
  });

  it("degrades to [] (never throws) when the sidecar is down or errors", async () => {
    const down = createGraphitiRecall({
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await down.recall("acc_1", "q")).toEqual([]);

    const err = createGraphitiRecall({ fetchImpl: fakeFetch(500, {}) });
    expect(await err.recall("acc_1", "q")).toEqual([]);
  });
});
