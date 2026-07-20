import { describe, it, expect } from "vitest";
import type {
  EnrichmentProvider,
  EnrichmentRecord,
  GuidelineCorpus,
} from "@mstack/core";
import { retrieveTool, sqlQueryTool, enrichTool } from "./tools.js";
import { toInputSchema } from "./json-schema.js";
import { contextPack } from "./context-pack.js";
import { checkPromptHygiene } from "./hygiene.js";

describe("built-in tool factories", () => {
  it("retrieveTool wraps GuidelineCorpus.retrieve and exposes a JSON-schema input", async () => {
    const corpus: GuidelineCorpus = {
      ingest: async () => {},
      retrieve: async (query, k) =>
        Array.from({ length: k }, (_v, i) => ({
          id: `p${i}`,
          content: `${query}#${i}`,
          score: 1 - i * 0.1,
        })),
      rules: async () => [],
    };
    const tool = retrieveTool(corpus);
    expect(tool.name).toBe("retrieve");

    const res = (await tool.handler({ query: "figma roi", k: 2 })) as Array<{
      id: string;
    }>;
    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe("p0");

    const js = toInputSchema(tool.inputSchema);
    expect(js["type"]).toBe("object");
    expect(js["$schema"]).toBeUndefined(); // stripped
  });

  it("retrieveTool applies the default k when omitted", async () => {
    let seenK = -1;
    const corpus: GuidelineCorpus = {
      ingest: async () => {},
      retrieve: async (_q, k) => {
        seenK = k;
        return [];
      },
      rules: async () => [],
    };
    await retrieveTool(corpus).handler({ query: "x" });
    expect(seenK).toBe(5);
  });

  it("sqlQueryTool passes sql + params through to the query fn", async () => {
    const seen: { sql: string; params?: unknown[] } = { sql: "" };
    const tool = sqlQueryTool(async (sql, params) => {
      seen.sql = sql;
      seen.params = params;
      return [{ n: 1 }];
    });
    const rows = (await tool.handler({
      sql: "select 1",
      params: ["a"],
    })) as unknown[];
    expect(rows).toEqual([{ n: 1 }]);
    expect(seen.sql).toBe("select 1");
    expect(seen.params).toEqual(["a"]);
  });

  it("enrichTool delegates to EnrichmentProvider.enrich", async () => {
    const record: EnrichmentRecord = {
      domain: "figma.com",
      firmographic: { tech: [] },
      provenance: {},
      source: "sample",
    };
    const provider: EnrichmentProvider = {
      name: "sample",
      enrich: async (ref) => (ref.domain === "figma.com" ? record : null),
    };
    const tool = enrichTool(provider);
    expect(await tool.handler({ domain: "figma.com" })).toEqual(record);
    expect(await tool.handler({ domain: "unknown.com" })).toBeNull();
  });

  it("tool handlers reject invalid input (thrown ZodError the loop catches)", async () => {
    const tool = sqlQueryTool(async () => []);
    await expect(tool.handler({ sql: 123 })).rejects.toBeTruthy();
  });
});

describe("contextPack", () => {
  it("renders labeled evidence blocks", () => {
    const s = contextPack([
      { label: "RULES", content: "no guarantees" },
      { label: "SIGNALS", content: "opened docs 3x" },
    ]);
    expect(s).toContain('label="RULES"');
    expect(s).toContain("no guarantees");
    expect(s).toContain('label="SIGNALS"');
    expect(s).toContain("opened docs 3x");
  });
});

describe("checkPromptHygiene", () => {
  it("passes a job-as-function prompt", () => {
    expect(
      checkPromptHygiene("You produce a claim-drift review. Return only the JSON."),
    ).toEqual([]);
  });
  it("flags identity inflation", () => {
    const w = checkPromptHygiene("You are an elite world-class reviewer.");
    expect(w.some((x) => x.rule === "identity-inflation")).toBe(true);
  });
  it("flags panic framing", () => {
    const w = checkPromptHygiene("CRITICAL: you MUST NOT FAIL.");
    expect(w.some((x) => x.rule === "panic-framing")).toBe(true);
  });
});
