import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { Signal } from "@mstack/core";

import { SampleSource } from "./sample-source.js";

describe("SampleSource", () => {
  it("loads the real data/signals.sample.jsonl fixture and every row is a valid Signal", async () => {
    const signals = await new SampleSource().pull();
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(() => Signal.parse(signal)).not.toThrow();
    }
    // Sanity: this is the REAL fixture (85 rows per data/README.md), not the 2-row fallback --
    // proves repo-root resolution actually found the file rather than silently degrading.
    expect(signals.length).toBeGreaterThan(10);
  });

  it('has the name "sample"', () => {
    expect(new SampleSource().name).toBe("sample");
  });

  it("respects PullOptions.limit", async () => {
    const signals = await new SampleSource().pull({ limit: 3 });
    expect(signals).toHaveLength(3);
  });

  it("respects PullOptions.since (ts >= since)", async () => {
    const all = await new SampleSource().pull();
    const midSignal = all[Math.floor(all.length / 2)];
    if (!midSignal) throw new Error("fixture too small for this test");

    const since = await new SampleSource().pull({ since: midSignal.ts });
    expect(since.length).toBeGreaterThan(0);
    expect(since.length).toBeLessThan(all.length);
    expect(since.every((s) => s.ts >= midSignal.ts)).toBe(true);
  });

  it("falls back to the tiny inline fixture when the data dir does not exist, without throwing", async () => {
    const source = new SampleSource({ dataDir: "C:/definitely/not/a/real/path/xyz" });
    const signals = await source.pull();
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(() => Signal.parse(signal)).not.toThrow();
  });

  it("honors an explicit dataDir pointing at the real repo-root data/ dir", async () => {
    const dataDir = fileURLToPath(new URL("../../../data", import.meta.url));
    const signals = await new SampleSource({ dataDir }).pull();
    expect(signals.length).toBeGreaterThan(10);
  });

  it("SAMPLE_DATA_DIR env override is honored when no explicit dataDir is passed", async () => {
    const dataDir = fileURLToPath(new URL("../../../data", import.meta.url));
    const prev = process.env["SAMPLE_DATA_DIR"];
    process.env["SAMPLE_DATA_DIR"] = dataDir;
    try {
      const signals = await new SampleSource().pull();
      expect(signals.length).toBeGreaterThan(10);
    } finally {
      if (prev === undefined) delete process.env["SAMPLE_DATA_DIR"];
      else process.env["SAMPLE_DATA_DIR"] = prev;
    }
  });
});
