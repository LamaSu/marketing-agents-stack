import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Outcome, PullOptions } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { ingestOutcomes } from "./ingest.js";
import type { OutcomeSource } from "./outcome-source.js";
import { SampleOutcomeSource } from "./sample-outcome-source.js";

/** A tiny fixed in-memory OutcomeSource for tests that need to control the exact rows
 *  returned (including a deliberately duplicated id), independent of the bundled sample
 *  fixture's contents. */
class FixedOutcomeSource implements OutcomeSource {
  readonly name = "fixed-test-source";
  constructor(private readonly rows: Outcome[]) {}
  async pull(): Promise<Outcome[]> {
    return this.rows;
  }
}

const now = "2026-07-20T00:00:00.000Z";

describe("ingestOutcomes", () => {
  let repo: MemoryRepo;

  beforeEach(async () => {
    // Fresh in-memory DB per test -- openMemory() never caches internally (memory-repo.ts
    // file header / memory-repo.test.ts's own beforeEach pattern).
    repo = await openMemory(":memory:");
  });

  afterEach(async () => {
    await repo.close();
  });

  it("persists every Outcome the source pulls into memory", async () => {
    const source = new SampleOutcomeSource();
    const expected = await source.pull();

    const result = await ingestOutcomes(source, repo);
    expect(result.pulled).toBe(expected.length);
    expect(result.ingested).toBe(expected.length);
    expect(result.skippedDuplicateIds).toEqual([]);

    for (const outcome of expected) {
      const rows = await repo.query<{ id: string }>("SELECT id FROM outcomes WHERE id = $id", { id: outcome.id });
      expect(rows).toHaveLength(1);
    }
  });

  it("is idempotent on re-run: ingesting the same source twice leaves the same rows, no duplicates", async () => {
    const source = new SampleOutcomeSource();

    const first = await ingestOutcomes(source, repo);
    const second = await ingestOutcomes(source, repo);
    expect(second.ingested).toBe(first.ingested);

    const rows = await repo.query<{ id: string }>("SELECT id FROM outcomes");
    const expected = await source.pull();
    expect(rows).toHaveLength(expected.length); // not doubled
  });

  it("dedupes an id repeated within a single pull, reporting it in skippedDuplicateIds", async () => {
    const dup: Outcome = { id: "out_dup_1", refType: "draft", refId: "dr_1", result: "replied", ts: now };
    const source = new FixedOutcomeSource([dup, { ...dup, result: "no_response" }]);

    const result = await ingestOutcomes(source, repo);
    expect(result.pulled).toBe(2);
    expect(result.ingested).toBe(1);
    expect(result.skippedDuplicateIds).toEqual(["out_dup_1"]);

    const rows = await repo.query<{ data: string }>("SELECT data FROM outcomes WHERE id = $id", { id: "out_dup_1" });
    expect(rows).toHaveLength(1);
    // the FIRST occurrence in the batch wins (result:"replied"); the duplicate never overwrites it.
    const row = rows[0];
    expect(row).toBeDefined();
    expect(JSON.parse(row?.data ?? "{}").result).toBe("replied");
  });

  it("passes PullOptions through to the source", async () => {
    let capturedOpts: PullOptions | undefined;
    class SpySource implements OutcomeSource {
      readonly name = "spy";
      async pull(opts?: PullOptions): Promise<Outcome[]> {
        capturedOpts = opts;
        return [];
      }
    }
    await ingestOutcomes(new SpySource(), repo, { since: now, limit: 10 });
    expect(capturedOpts).toEqual({ since: now, limit: 10 });
  });

  it("returns zero counts for an empty pull without touching memory", async () => {
    const source = new FixedOutcomeSource([]);
    const result = await ingestOutcomes(source, repo);
    expect(result).toEqual({ pulled: 0, ingested: 0, skippedDuplicateIds: [] });
  });
});
