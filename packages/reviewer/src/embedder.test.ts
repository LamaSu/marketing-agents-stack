import { describe, it, expect } from "vitest";

import { FakeEmbedder } from "./index.js";

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

describe("FakeEmbedder — deterministic, offline, dependency-free (used by every test in this package)", () => {
  it("is deterministic: the same text embeds to the same vector, even across separate instances", async () => {
    const text = "KLZ Orchestrate guarantees a 10x ROI";
    const a = await new FakeEmbedder().embed([text]);
    const b = await new FakeEmbedder().embed([text]);
    expect(a).toEqual(b);
  });

  it("returns one vector of the configured dimensionality per input text", async () => {
    const embedder = new FakeEmbedder(64);
    const vectors = await embedder.embed(["hello world", "a second, different sentence"]);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) expect(v).toHaveLength(64);
  });

  it("defaults to 128 dimensions", async () => {
    const [v] = await new FakeEmbedder().embed(["anything"]);
    expect(v).toHaveLength(128);
  });

  it("returns [] for an empty input array, without error", async () => {
    expect(await new FakeEmbedder().embed([])).toEqual([]);
  });

  it("does not crash or produce NaN on an empty string", async () => {
    const [v] = await new FakeEmbedder(32).embed([""]);
    expect(v).toHaveLength(32);
    expect(v?.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("different texts produce different vectors", async () => {
    const [a, b] = await new FakeEmbedder().embed(["guarantee results", "totally unrelated words here"]);
    expect(a).not.toEqual(b);
  });

  it("is L2-normalized (unit vectors, up to floating point tolerance)", async () => {
    const [v] = await new FakeEmbedder().embed(["some reasonably long sentence to embed for this check"]);
    const norm = Math.sqrt(dot(v ?? [], v ?? []));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("ranks lexically-similar text above unrelated text -- a real (if crude) similarity signal, not just plumbing", async () => {
    const embedder = new FakeEmbedder();
    // "unrelated" deliberately shares zero word-tokens with "query" (no
    // stopword overlap like "the"/"in" either) so the expected margin is
    // large and unambiguous -- simToUnrelated should be ~0 (modulo rare hash-
    // bucket collisions), simToSimilar strictly positive from 4 shared
    // content words (klz, orchestrate, guarantees, roi).
    const [query, similar, unrelated] = await embedder.embed([
      "KLZ Orchestrate guarantees a 10x ROI this year",
      "KLZ Orchestrate guarantees amazing ROI results for every customer",
      "Purple bicycles roll past sleepy gardens near dusk",
    ]);
    const simToSimilar = dot(query ?? [], similar ?? []);
    const simToUnrelated = dot(query ?? [], unrelated ?? []);
    expect(simToSimilar).toBeGreaterThan(simToUnrelated);
    expect(simToSimilar).toBeGreaterThan(0);
  });
});
