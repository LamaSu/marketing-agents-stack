import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { loadGuidelinesJson, loadApprovedMessagingMarkdown, chunkApprovedMessagingMarkdown, loadFullGuidelineCorpus, loadReviewRequests } from "./index.js";

describe("corpus-loader — reads data/corpus/* into @mstack/core-validated values", () => {
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  it("loadGuidelinesJson returns the curated Guideline rows from data/corpus/guidelines.json", async () => {
    const rows = await loadGuidelinesJson();
    // data/README.md documents 20 rows; a loose bound keeps this test from
    // being the thing that breaks if the fixture grows -- data/validate.test.ts
    // is the source of truth for the fixture's exact shape/counts.
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
    expect(rows.some((r) => r.type === "tier_map")).toBe(true);
  });

  it("rejects a well-formed JSON file that isn't an array", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "mstack-reviewer-loader-"));
    const badPath = join(scratchDir, "not-an-array.json");
    await writeFile(badPath, JSON.stringify({ oops: "this is an object, not an array" }), "utf8");
    await expect(loadGuidelinesJson(badPath)).rejects.toThrow(/expected a JSON array/);
  });

  it("rejects a JSON array whose rows don't match the Guideline schema", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "mstack-reviewer-loader-"));
    const badPath = join(scratchDir, "invalid-rows.json");
    await writeFile(badPath, JSON.stringify([{ notAGuideline: true }]), "utf8");
    await expect(loadGuidelinesJson(badPath)).rejects.toThrow();
  });

  it("loadApprovedMessagingMarkdown returns the raw prose, unparsed", async () => {
    const md = await loadApprovedMessagingMarkdown();
    expect(md).toContain("KLZ Orchestrate");
    expect(md.length).toBeGreaterThan(1000);
  });

  it("chunkApprovedMessagingMarkdown splits into one valid Guideline per ## section, with unique ids", async () => {
    const md = await loadApprovedMessagingMarkdown();
    const chunks = chunkApprovedMessagingMarkdown(md);

    expect(chunks.length).toBeGreaterThanOrEqual(5); // the sample doc has 8 `##` sections
    for (const c of chunks) {
      expect(c.type).toBe("approved_messaging");
      expect(c.content.length).toBeGreaterThanOrEqual(40);
      expect(c.id.startsWith("md-")).toBe(true);
      expect(c.severity).toBe("low");
    }
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("chunking is idempotent: the same markdown always produces the same ids", async () => {
    const md = await loadApprovedMessagingMarkdown();
    const a = chunkApprovedMessagingMarkdown(md).map((c) => c.id);
    const b = chunkApprovedMessagingMarkdown(md).map((c) => c.id);
    expect(a).toEqual(b);
  });

  it("loadFullGuidelineCorpus combines guidelines.json + chunked markdown, with globally-unique ids", async () => {
    const [jsonRows, md] = await Promise.all([loadGuidelinesJson(), loadApprovedMessagingMarkdown()]);
    const mdChunks = chunkApprovedMessagingMarkdown(md);
    const full = await loadFullGuidelineCorpus();

    expect(full.length).toBe(jsonRows.length + mdChunks.length);
    const ids = full.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    // gl-* (guidelines.json) vs md-* (chunked markdown) ids can never collide by construction.
    expect(full.some((g) => g.id.startsWith("gl-"))).toBe(true);
    expect(full.some((g) => g.id.startsWith("md-"))).toBe(true);
  });

  it("loadReviewRequests returns the sample partner submissions, each a valid ReviewRequest", async () => {
    const assets = await loadReviewRequests();
    expect(assets.length).toBeGreaterThanOrEqual(3);
    expect(assets.length).toBeLessThanOrEqual(4);
    const partnerIds = assets.map((a) => a.partnerId);
    expect(partnerIds).toContain("ABC Corp");
    for (const a of assets) {
      expect(typeof a.content).toBe("string");
      expect(a.content.length).toBeGreaterThan(0);
    }
  });
});
