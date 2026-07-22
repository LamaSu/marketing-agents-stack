import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { Outcome } from "@mstack/core";

import { SampleOutcomeSource, sampleOutcomeSource } from "./sample-outcome-source.js";

describe("SampleOutcomeSource", () => {
  it("loads the bundled data/outcomes.sample.jsonl fixture and every row is a valid Outcome", async () => {
    const outcomes = await new SampleOutcomeSource().pull();
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(() => Outcome.parse(outcome)).not.toThrow();
    }
    // Sanity: this is the REAL fixture (8 rows), not the 2-row fallback -- proves
    // package-relative resolution actually found the file rather than silently degrading.
    expect(outcomes.length).toBeGreaterThan(2);
  });

  it("yields a FIXED, deterministic set of Outcomes across repeated pulls", async () => {
    const first = await new SampleOutcomeSource().pull();
    const second = await new SampleOutcomeSource().pull();
    expect(second).toEqual(first);
  });

  it("covers the return-leg results this seam exists for: replied, meeting, no_response", async () => {
    const outcomes = await new SampleOutcomeSource().pull();
    const results = new Set(outcomes.map((o) => o.result));
    expect(results.has("replied")).toBe(true);
    expect(results.has("meeting")).toBe(true);
    expect(results.has("no_response")).toBe(true);
  });

  it('has the name "sample" by default, overridable via config', () => {
    expect(new SampleOutcomeSource().name).toBe("sample");
    expect(new SampleOutcomeSource({ name: "custom" }).name).toBe("custom");
  });

  it("respects PullOptions.limit", async () => {
    const outcomes = await new SampleOutcomeSource().pull({ limit: 2 });
    expect(outcomes).toHaveLength(2);
  });

  it("respects PullOptions.since (ts >= since)", async () => {
    const all = await new SampleOutcomeSource().pull();
    const midOutcome = all[Math.floor(all.length / 2)];
    if (!midOutcome) throw new Error("fixture too small for this test");

    const since = await new SampleOutcomeSource().pull({ since: midOutcome.ts });
    expect(since.length).toBeGreaterThan(0);
    expect(since.length).toBeLessThan(all.length);
    expect(since.every((o) => o.ts >= midOutcome.ts)).toBe(true);
  });

  it("falls back to the tiny inline fixture when the data dir does not exist, without throwing", async () => {
    const source = new SampleOutcomeSource({ dataDir: "C:/definitely/not/a/real/path/xyz" });
    const outcomes = await source.pull();
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect(() => Outcome.parse(outcome)).not.toThrow();
  });

  it("honors an explicit dataDir pointing at this package's own data/ dir", async () => {
    const dataDir = fileURLToPath(new URL("../data", import.meta.url));
    const outcomes = await new SampleOutcomeSource({ dataDir }).pull();
    expect(outcomes.length).toBeGreaterThan(2);
  });

  it("OUTCOME_SAMPLE_DATA_DIR env override is honored when no explicit dataDir is passed", async () => {
    const dataDir = fileURLToPath(new URL("../data", import.meta.url));
    const prev = process.env["OUTCOME_SAMPLE_DATA_DIR"];
    process.env["OUTCOME_SAMPLE_DATA_DIR"] = dataDir;
    try {
      const outcomes = await new SampleOutcomeSource().pull();
      expect(outcomes.length).toBeGreaterThan(2);
    } finally {
      if (prev === undefined) delete process.env["OUTCOME_SAMPLE_DATA_DIR"];
      else process.env["OUTCOME_SAMPLE_DATA_DIR"] = prev;
    }
  });

  it("sampleOutcomeSource() factory function returns a SampleOutcomeSource", () => {
    expect(sampleOutcomeSource()).toBeInstanceOf(SampleOutcomeSource);
  });
});
