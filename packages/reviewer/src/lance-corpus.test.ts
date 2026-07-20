import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Guideline } from "@mstack/core";

import { LanceCorpus, createLanceCorpus, FakeEmbedder, loadFullGuidelineCorpus } from "./index.js";

describe("LanceCorpus — GuidelineCorpus over LanceDB, offline via the injectable Embedder", () => {
  let dir: string;
  let corpus: LanceCorpus;
  let guidelines: Guideline[];

  beforeEach(async () => {
    // A real temp directory, not an in-memory URI -- lancedb's Node client
    // doesn't confirm a dedicated in-memory scheme at this version (see
    // lance-corpus.ts file header), so this is the offline-safe, isolated
    // option the task calls for ("Use a temp-dir or in-memory LanceDB in
    // tests").
    dir = await mkdtemp(join(tmpdir(), "mstack-reviewer-lance-"));
    corpus = new LanceCorpus({ dbPath: dir, embedder: new FakeEmbedder() });
    guidelines = await loadFullGuidelineCorpus();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("retrieve() before any ingest() call returns [] rather than throwing", async () => {
    expect(await corpus.retrieve("anything", 3)).toEqual([]);
  });

  it("rules() before any ingest() call returns []", async () => {
    expect(await corpus.rules()).toEqual([]);
  });

  it("ingest() + retrieve() round-trips real sample-corpus passages, fully offline (FakeEmbedder: no network, no model download)", async () => {
    await corpus.ingest(guidelines);
    const passages = await corpus.retrieve("does KLZ Orchestrate guarantee results, or report a cited outcome?", 3);

    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(3);
    for (const p of passages) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.content).toBe("string");
      expect(p.content.length).toBeGreaterThan(0);
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
  });

  it("retrieve() ranks a lexically-matching passage inside the top-k, not just a random member of the corpus", async () => {
    await corpus.ingest(guidelines);
    // gl-msg-proof-1's content is the cited "median 35% reduction ... published
    // at klz.com/reports/q2-2026" passage -- this query shares almost every
    // token with it and with no other passage in the ~15-row corpus.
    const passages = await corpus.retrieve("35% reduction manual workflow processing time published klz.com reports", 5);
    expect(passages.some((p) => p.id === "gl-msg-proof-1")).toBe(true);
  });

  it("retrieve() with k=0 returns [] without querying", async () => {
    await corpus.ingest(guidelines);
    expect(await corpus.retrieve("anything", 0)).toEqual([]);
  });

  it("rules() returns only the non-approved_messaging rows, including the Elite-badge tier_map row", async () => {
    await corpus.ingest(guidelines);
    const rules = await corpus.rules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.type !== "approved_messaging")).toBe(true);
    expect(rules.some((r) => r.type === "tier_map" && r.content.includes("Powered by KLZ Orchestrate"))).toBe(true);
    expect(rules.some((r) => r.type === "lexicon")).toBe(true);
    expect(rules.some((r) => r.type === "denylist")).toBe(true);
    expect(rules.some((r) => r.type === "allowlist")).toBe(true);
  });

  it("count() reflects the number of embedded approved_messaging passages, 0 before ingest", async () => {
    expect(await corpus.count()).toBe(0);
    await corpus.ingest(guidelines);
    const expected = guidelines.filter((g) => g.type === "approved_messaging").length;
    expect(await corpus.count()).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("re-ingesting overwrites rather than duplicating rows", async () => {
    await corpus.ingest(guidelines);
    const first = await corpus.count();
    await corpus.ingest(guidelines);
    expect(await corpus.count()).toBe(first);
  });

  it("ingest([]) on a fresh corpus leaves it empty: retrieve() -> [], rules() -> []", async () => {
    await corpus.ingest([]);
    expect(await corpus.retrieve("anything", 3)).toEqual([]);
    expect(await corpus.rules()).toEqual([]);
    expect(await corpus.count()).toBe(0);
  });

  it("createLanceCorpus wires an explicit (offline-safe) embedder through the factory default path", async () => {
    const factoryCorpus = createLanceCorpus({ dbPath: dir, embedder: new FakeEmbedder(), tableName: "factory_test_table" });
    await factoryCorpus.ingest(guidelines);
    const passages = await factoryCorpus.retrieve("guarantee", 2);
    expect(passages.length).toBeGreaterThan(0);
  });
});
