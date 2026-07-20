import { describe, it, expect } from "vitest";
import {
  Signal, Account, Claim, Guideline, Finding, Review, Decision, Draft, Approval, Outcome,
  ReviewRequest, ReviewResult, AccountDecision, scoreForChanges, newId, sha256Hex, GENESIS_HASH,
} from "./index.js";

const now = "2026-07-20T00:00:00.000Z";

describe("domain primitives round-trip", () => {
  it("Signal", () => {
    expect(Signal.parse({ id: "sig_1", ts: now, source: "sample", kind: "product_usage",
      actor: { company: "figma.com" }, action: "opened_docs" }).kind).toBe("product_usage");
  });
  it("Account", () => {
    const a = Account.parse({ id: "acc_1", domain: "figma.com", name: "Figma",
      firmographic: { employees: 1500, tech: ["react"] } });
    expect(a.buyingCommittee).toEqual([]); // defaulted
    expect(a.provenance).toEqual({});
  });
  it("Claim / Guideline", () => {
    expect(Claim.parse({ id: "c1", assetId: "as1", text: "10x ROI", checkWorthy: true }).extractedBy).toBe("claude");
    expect(Guideline.parse({ id: "g1", category: "uncited_quantitative", type: "denylist",
      content: "no uncited stats", source: "seed" }).version).toBe("1");
  });
  it("Finding / Review", () => {
    const f = Finding.parse({ id: "f1", reviewId: "r1", category: "guaranteed_outcome", required: true,
      quote: "guarantees 10x ROI", recommendedChange: "remove the guarantee",
      supportingPassageId: null, detectedBy: "deterministic", severity: "high" });
    const r = Review.parse({ id: "r1", assetId: "as1", partnerId: "abc", partnerTier: "Select",
      score: 2, changesCount: 4, verdict: "RETURNED", findings: [f], createdAt: now });
    expect(r.verdict).toBe("RETURNED");
  });
  it("Decision / Draft / Approval / Outcome", () => {
    Decision.parse({ id: "d1", accountId: "acc_1", ts: now, score: 76, tier: "FIT",
      relevantSignals: [{ signalId: "sig_1", why: "evaluating collaboration infra" }],
      buyingCommittee: [], nextBestAction: { action: "email", channel: "email", targetMember: "VP Eng" },
      rationale: "high intent", byAgent: "gtm-router", mode: "copilot" });
    const d = Draft.parse({ id: "dr1", kind: "outreach_email", refId: "acc_1", body: "hi", createdBy: "copywriter", createdAt: now });
    expect(d.status).toBe("pending"); // never auto-approved
    Approval.parse({ id: "ap1", draftId: "dr1", decision: "approve", actor: "human", ts: now, prevHash: GENESIS_HASH, hash: sha256Hex("x") });
    Outcome.parse({ id: "o1", refType: "draft", refId: "dr1", result: "sent", ts: now });
  });
});

describe("agent contracts", () => {
  it("ReviewRequest / ReviewResult", () => {
    ReviewRequest.parse({ partnerId: "abc", partnerTier: "Select", contentTitle: "t", contentType: "blog", content: "..." });
    ReviewResult.parse({ score: 5, changesCount: 0, verdict: "APPROVED", findings: [], summary: "clean" });
  });
  it("GUARDRAIL #1: ReviewResult schema has NO field for generated marketing prose", () => {
    const keys = Object.keys((ReviewResult as any).shape);
    for (const banned of ["content", "generatedContent", "rewrite", "draftContent", "copy", "body"]) {
      expect(keys).not.toContain(banned);
    }
  });
  it("AccountDecision requires cited signalIds", () => {
    const parsed = AccountDecision.parse({ account: { domain: "figma.com", name: "Figma" }, score: 76, tier: "FIT",
      relevantSignals: [{ signalId: "sig_1", why: "x" }], buyingCommittee: [],
      nextBestAction: { action: "a", channel: "email", targetMember: "m" }, rationale: "r" });
    expect(parsed.relevantSignals[0]?.signalId).toBe("sig_1");
  });
});

describe("rubric + utils", () => {
  it("scoreForChanges maps per the Portal rubric", () => {
    expect(scoreForChanges(0)).toBe(5);
    expect(scoreForChanges(1)).toBe(4);
    expect(scoreForChanges(2)).toBe(4);
    expect(scoreForChanges(3)).toBe(3);
    expect(scoreForChanges(4)).toBe(2);
    expect(scoreForChanges(7)).toBe(1);
  });
  it("newId is prefixed + unique", () => {
    const a = newId("sig"), b = newId("sig");
    expect(a.startsWith("sig_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
