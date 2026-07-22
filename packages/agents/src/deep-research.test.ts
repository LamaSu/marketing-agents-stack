import { describe, it, expect, vi } from "vitest";
import { deepResearchTool } from "./deep-research.js";
import type { DeepResearchResult } from "./deep-research.js";
import { retrieveTool, sqlQueryTool, enrichTool } from "./tools.js";

/** A fake fetch returning a scripted Response-like object. */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("deepResearchTool", () => {
  it("POSTs the query to the sidecar's /report/ and returns the report + sources on success", async () => {
    const fetchImpl = fakeFetch(200, {
      report: "ACME is migrating to AWS in Q3.",
      source_urls: ["https://acme.com/blog/cloud"],
    });
    const tool = deepResearchTool({ baseUrl: "http://sidecar.local:8001/", fetchImpl });

    const result = (await tool.handler({ query: "ACME cloud strategy?" })) as DeepResearchResult;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, { body?: string }][] } }).mock.calls[0]!;
    expect(url).toBe("http://sidecar.local:8001/report/"); // trailing slash stripped from base, endpoint added
    expect(JSON.parse(String(init.body))).toEqual({
      task: "ACME cloud strategy?",
      report_type: "research_report",
      report_source: "web",
    });
    expect(result).toEqual({
      ok: true,
      report: "ACME is migrating to AWS in Q3.",
      sources: ["https://acme.com/blog/cloud"],
    });
  });

  it("tolerates alternate field names (research_information / sources)", async () => {
    const fetchImpl = fakeFetch(200, {
      research_information: "Findings...",
      sources: ["https://x.example"],
    });
    const tool = deepResearchTool({ fetchImpl });
    const result = (await tool.handler({ query: "q" })) as DeepResearchResult;
    expect(result.ok).toBe(true);
    expect(result.report).toBe("Findings...");
    expect(result.sources).toEqual(["https://x.example"]);
  });

  it("degrades to ok:false (never throws) when the sidecar is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const tool = deepResearchTool({ fetchImpl });
    const result = (await tool.handler({ query: "q" })) as DeepResearchResult;
    expect(result.ok).toBe(false);
    expect(result.report).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("degrades to ok:false on a non-OK status and on an empty report", async () => {
    const down = deepResearchTool({ fetchImpl: fakeFetch(503, {}) });
    expect(((await down.handler({ query: "q" })) as DeepResearchResult).ok).toBe(false);

    const empty = deepResearchTool({ fetchImpl: fakeFetch(200, { report: "   " }) });
    expect(((await empty.handler({ query: "q" })) as DeepResearchResult).ok).toBe(false);
  });

  it("is opt-in: NOT one of the built-in default tool factories", () => {
    // The offline default tool-set is assembled from tools.ts's factories. This
    // asserts deep_research is a DISTINCT, separately-imported tool — a caller
    // must consciously add it; it is never auto-included.
    const builtinNames = [
      retrieveTool({ retrieve: async () => [], ingest: async () => {}, rules: async () => [] }).name,
      sqlQueryTool(async () => []).name,
      enrichTool({ name: "x", enrich: async () => null }).name,
    ];
    expect(builtinNames).not.toContain("deep_research");
    expect(deepResearchTool().name).toBe("deep_research");
  });
});
