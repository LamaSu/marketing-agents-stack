import { describe, it, expect } from "vitest";
import { Account, Signal } from "@mstack/core";
import {
  GaussianProcessQualifier,
  approvalToLabel,
  HybridScorer,
  type LabeledExample,
  type QualifierCandidate,
} from "./index.js";

/* Account/Signal builders (mirror index.test.ts). */
function account(id: string, overrides: Record<string, unknown> = {}) {
  return Account.parse({
    id,
    domain: `${id}.com`,
    name: id,
    firmographic: { employees: 1000, industry: "Software", region: "US", tech: ["react", "aws"] },
    ...overrides,
  });
}
function signal(overrides: Record<string, unknown> = {}) {
  return Signal.parse({
    id: "sig_1",
    ts: "2020-01-01T00:00:00.000Z", // far past -> recent_activity deterministically 0
    source: "sample",
    kind: "product_usage",
    actor: { company: "acc_a.com" },
    ...overrides,
  });
}

/* Deterministic stub featurizer keyed by account id -- decouples the GP-math tests from
 * Date.now() (the real featurize's recent-activity bit) so vectors are fixed and exact. */
const VECTORS: Record<string, number[]> = {
  acc_a: [3, 3, 3, 2, 1],
  acc_b: [0, 0, 0, 0, 0], // far from A -> should stay uncertain after fitting only A
  acc_c: [3, 3, 3, 2, 0], // near A -> should become fairly certain after fitting A
};
const stubFeaturize = (acct: Account): number[] => VECTORS[acct.id] ?? [0, 0, 0, 0, 0];

const A = account("acc_a");
const B = account("acc_b");
const C = account("acc_c");
const noSignals: Signal[] = [];

describe("GaussianProcessQualifier -- cold-start (offline default, zero labels)", () => {
  it("is unfitted on construction and yields the uniform prior for every account", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize, signalVariance: 1 });
    expect(gp.fitted).toBe(false);

    const pa = gp.posteriorFor(A, noSignals);
    const pb = gp.posteriorFor(B, noSignals);

    // prior mean 0.5, variance == signalVariance, identical regardless of the account
    expect(pa.mean).toBeCloseTo(0.5, 12);
    expect(pa.variance).toBeCloseTo(1, 12);
    expect(pb.variance).toBeCloseTo(1, 12);
    expect(pa.variance).toBe(pb.variance); // uniform MAX uncertainty -> everything routes to review
  });

  it("score() surfaces the cold-start prior and a valid ScoreResult", async () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize });
    const result = await gp.score(A, noSignals);
    expect(result.score).toBe(50); // 0.5 * 100
    expect(typeof result.tier).toBe("string");
    expect(result.rationale).toContain("cold-start");
    expect(gp.name).toBe("gp-qualifier");
  });
});

describe("GaussianProcessQualifier -- fit lowers uncertainty near labeled points", () => {
  it("a fitted point is far more certain than a distant one (variance in [0, signalVariance])", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize }).fit([{ account: A, signals: noSignals, label: 1 }]);
    expect(gp.fitted).toBe(true);

    const near = gp.posteriorFor(A, noSignals); // the trained point itself
    const far = gp.posteriorFor(B, noSignals); // far in feature space

    expect(near.variance).toBeGreaterThanOrEqual(0);
    expect(near.variance).toBeLessThanOrEqual(1);
    expect(near.variance).toBeLessThan(0.5); // markedly below the prior (1)
    expect(far.variance).toBeGreaterThan(near.variance); // distant point stays uncertain
    expect(near.mean).toBeGreaterThan(0.5); // pulled toward the label (1)
  });

  it("posterior mean/variance are sane on a tiny two-label dataset (1 approve, 0 reject)", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize }).fit([
      { account: A, signals: noSignals, label: 1 },
      { account: B, signals: noSignals, label: 0 },
    ]);

    const pa = gp.posteriorFor(A, noSignals);
    const pb = gp.posteriorFor(B, noSignals);

    expect(pa.mean).toBeGreaterThan(pb.mean); // approved account scores above the rejected one
    for (const p of [pa, pb]) {
      expect(Number.isFinite(p.mean)).toBe(true);
      expect(p.variance).toBeGreaterThanOrEqual(0);
      expect(p.variance).toBeLessThanOrEqual(1);
    }
  });

  it("fit([]) resets to the cold-start prior", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize }).fit([{ account: A, signals: noSignals, label: 1 }]);
    expect(gp.fitted).toBe(true);
    gp.fit([]);
    expect(gp.fitted).toBe(false);
    expect(gp.posteriorFor(A, noSignals).variance).toBeCloseTo(1, 12);
  });
});

describe("GaussianProcessQualifier -- BALD selectForReview", () => {
  it("ranks the highest-uncertainty accounts first (top-k for the approval queue)", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize }).fit([{ account: A, signals: noSignals, label: 1 }]);
    const candidates: QualifierCandidate[] = [
      { account: A, signals: noSignals }, // near A -> low uncertainty
      { account: C, signals: noSignals }, // near-ish A -> medium
      { account: B, signals: noSignals }, // far -> high uncertainty
    ];

    const top1 = gp.selectForReview(candidates, 1);
    expect(top1).toHaveLength(1);
    expect(top1[0]?.account.id).toBe("acc_b"); // the most uncertain goes to review first

    const ranked = gp.selectForReview(candidates, -1); // all, uncertain-first
    expect(ranked.map((r) => r.account.id)).toEqual(["acc_b", "acc_c", "acc_a"]);
    // information gain is monotone with variance and sorted descending
    expect(ranked[0]!.informationGain).toBeGreaterThanOrEqual(ranked[1]!.informationGain);
    expect(ranked[1]!.informationGain).toBeGreaterThanOrEqual(ranked[2]!.informationGain);
  });

  it("cold-start routes everything equally (all candidates maximally uncertain)", () => {
    const gp = new GaussianProcessQualifier({ featurize: stubFeaturize }); // unfitted
    const ranked = gp.selectForReview([{ account: A, signals: noSignals }, { account: B, signals: noSignals }], -1);
    expect(ranked[0]!.informationGain).toBeCloseTo(ranked[1]!.informationGain, 12);
    expect(ranked[0]!.posterior.variance).toBeCloseTo(1, 12);
  });
});

describe("GaussianProcessQualifier -- determinism + real featurizer integration", () => {
  it("is deterministic: identical fit + query yield identical posteriors", () => {
    const mk = () => new GaussianProcessQualifier({ featurize: stubFeaturize }).fit([{ account: A, signals: noSignals, label: 1 }]);
    expect(mk().posteriorFor(C, noSignals)).toEqual(mk().posteriorFor(C, noSignals));
  });

  it("works over the real onnx-scorer featurize() with past-dated signals (offline, bounded)", async () => {
    const gp = new GaussianProcessQualifier(); // default = real featurize
    const examples: LabeledExample[] = [
      { account: account("acc_x", { firmographic: { employees: 2000, industry: "Software", region: "US", tech: ["react"] } }), signals: [signal({ id: "s1" })], label: 1 },
      { account: account("acc_y", { firmographic: { employees: null, industry: null, region: null, tech: [] } }), signals: noSignals, label: 0 },
    ];
    gp.fit(examples);
    const result = await gp.score(account("acc_x"), [signal({ id: "s1" })]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(typeof result.rationale).toBe("string");
  });
});

describe("approvalToLabel (label-loop contract)", () => {
  it("maps approve->1, reject->0, edit->null (edit excluded from supervision)", () => {
    expect(approvalToLabel("approve")).toBe(1);
    expect(approvalToLabel("reject")).toBe(0);
    expect(approvalToLabel("edit")).toBeNull();
  });
});

describe("additive-only: HybridScorer default is unchanged by the new export", () => {
  it("new HybridScorer() still returns rules-only, offline, and floors a disqualifier", async () => {
    const scorer = new HybridScorer(); // zero config -- must stay fully offline
    const ok = await scorer.score(account("acc_ok"), [signal()]);
    expect(ok.rationale).toContain("rules");
    expect(ok.rationale).not.toContain("gp-qualifier"); // qualifier is NOT wired into the blend

    const dq = await scorer.score(account("acc_dq"), [signal({ action: "unsubscribed" })]);
    expect(dq.tier).toBe("DISQUALIFIED");
    expect(dq.score).toBe(0);
  });
});
