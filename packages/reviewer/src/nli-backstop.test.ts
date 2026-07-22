import { describe, it, expect } from "vitest";

import { noopNliBackstop, createHhemBackstop, hhemBackstop } from "./index.js";

/* ─────────────────────────── noopNliBackstop ─────────────────────────── */

describe("noopNliBackstop", () => {
  it("always agrees with the judge (supported:false) -- the verdict is left unchanged, fully offline", async () => {
    const a = await noopNliBackstop.entails("KLZ Orchestrate guarantees a 10x ROI", "some passage");
    expect(a.supported).toBe(false);
    expect(typeof a.score).toBe("number");

    const b = await noopNliBackstop.entails("any claim at all", ""); // no passage available either
    expect(b.supported).toBe(false);
  });

  it("never touches the network -- same result regardless of input", async () => {
    const r1 = await noopNliBackstop.entails("claim one", "passage one");
    const r2 = await noopNliBackstop.entails("a totally different claim", "a totally different passage");
    expect(r1).toEqual(r2);
  });
});

/* ─────────────────── createHhemBackstop / hhemBackstop ─────────────────── */

describe("createHhemBackstop / hhemBackstop", () => {
  it("hhemBackstop is exported and directly usable as an NliBackstop value (the wiring docker/hhem.md shows)", () => {
    expect(typeof hhemBackstop.entails).toBe("function");
  });

  it("POSTs {claim, passage} to <baseUrl>/predict (trailing slash stripped) and thresholds the score (default 0.5)", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ score: 0.83 }), { status: 200 });
    };
    const backstop = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000/" });

    const result = await backstop.entails("KLZ ships a 10x ROI", "KLZ customers report varying ROI outcomes");

    expect(result).toEqual({ supported: true, score: 0.83 });
    expect(calls).toEqual([
      {
        url: "http://sidecar.local:8000/predict",
        body: { claim: "KLZ ships a 10x ROI", passage: "KLZ customers report varying ROI outcomes" },
      },
    ]);
  });

  it("supported is false below the threshold", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ score: 0.2 }), { status: 200 });
    const backstop = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000" });
    expect(await backstop.entails("claim", "passage")).toEqual({ supported: false, score: 0.2 });
  });

  it("a custom threshold shifts the supported boundary", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ score: 0.6 }), { status: 200 });
    const lenient = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000", threshold: 0.5 });
    const strict = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000", threshold: 0.7 });
    expect((await lenient.entails("c", "p")).supported).toBe(true);
    expect((await strict.entails("c", "p")).supported).toBe(false);
  });

  it("falls back to the no-op verdict (never throws) on a non-OK sidecar response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("internal error", { status: 500 });
    const backstop = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000" });
    await expect(backstop.entails("c", "p")).resolves.toEqual({ supported: false, score: 0 });
  });

  it("falls back to the no-op verdict (never throws) when the sidecar is unreachable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const backstop = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000" });
    await expect(backstop.entails("c", "p")).resolves.toEqual({ supported: false, score: 0 });
  });

  it("falls back to the no-op verdict on a malformed response (no numeric score)", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ oops: true }), { status: 200 });
    const backstop = createHhemBackstop({ fetchImpl, baseUrl: "http://sidecar.local:8000" });
    await expect(backstop.entails("c", "p")).resolves.toEqual({ supported: false, score: 0 });
  });
});
