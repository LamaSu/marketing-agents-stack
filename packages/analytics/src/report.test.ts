import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Signal, Account, Decision, Draft, Outcome, Review } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import {
  funnelReport,
  conversionByTier,
  reviewOutcomes,
  buildGtmReport,
  formatReport,
} from "./index.js";

const now = "2026-07-22T00:00:00.000Z";
const FIXED_NOW = () => now;

describe("@mstack/analytics — empty warehouse (must zero-fill, never crash)", () => {
  let repo: MemoryRepo;

  beforeEach(async () => {
    repo = await openMemory(":memory:");
  });

  afterEach(async () => {
    await repo.close();
  });

  it("funnelReport zero-fills every stage on an empty warehouse", async () => {
    const report = await funnelReport(repo, { now: FIXED_NOW });
    expect(report.generatedAt).toBe(now);
    expect(report.stages).toHaveLength(8);
    expect(report.stages[0]?.key).toBe("signalsIngested");
    expect(report.stages[0]?.count).toBe(0);
    expect(report.stages[0]?.conversionFromPrevious).toBeNull(); // first stage: no previous
    for (const stage of report.stages.slice(1)) {
      expect(stage.count).toBe(0);
      expect(stage.conversionFromPrevious).toBe(0); // 0/0 guarded to 0, not NaN
    }
  });

  it("conversionByTier returns all 4 AccountTier values zero-filled, none omitted", async () => {
    const report = await conversionByTier(repo, { now: FIXED_NOW });
    expect(report.tiers.map((t) => t.tier).sort()).toEqual(
      ["DISQUALIFIED", "FIT", "PARTIAL_FIT", "STRONG_FIT"].sort(),
    );
    for (const tier of report.tiers) {
      expect(tier.draftsCreated).toBe(0);
      expect(tier.sent).toBe(0);
      expect(tier.replied).toBe(0);
      expect(tier.meeting).toBe(0);
      expect(tier.sentRate).toBe(0);
      expect(tier.repliedRate).toBe(0);
      expect(tier.meetingRate).toBe(0);
    }
  });

  it("reviewOutcomes zero-fills verdicts and returns no claim-drift categories", async () => {
    const report = await reviewOutcomes(repo, { now: FIXED_NOW });
    expect(report.totalReviews).toBe(0);
    expect(report.approvalRate).toBe(0);
    expect(report.verdicts).toEqual([
      { verdict: "APPROVED", count: 0 },
      { verdict: "RETURNED", count: 0 },
    ]);
    expect(report.topClaimDriftCategories).toEqual([]);
  });

  it("buildGtmReport + formatReport never crash on an empty warehouse", async () => {
    const report = await buildGtmReport(repo, { now: FIXED_NOW });
    const text = formatReport(report);
    expect(text).toContain("GTM FUNNEL");
    expect(text).toContain("CONVERSION BY ACCOUNT TIER");
    expect(text).toContain("REVIEW OUTCOMES");
    expect(text).toContain("(no findings recorded)");
  });
});

describe("@mstack/analytics — seeded warehouse (funnel counts + conversion rates)", () => {
  let repo: MemoryRepo;

  beforeEach(async () => {
    repo = await openMemory(":memory:");

    // 2 signals ingested
    await repo.putSignal(
      Signal.parse({ id: "sig_1", ts: now, source: "sample", kind: "product_usage", actor: { company: "figma.com" }, action: "opened_docs" }),
    );
    await repo.putSignal(
      Signal.parse({ id: "sig_2", ts: now, source: "sample", kind: "crm", actor: { company: "airtable.com" }, action: "demo_booked" }),
    );

    // 2 accounts — only acc_1 has been scored (has a tier)
    await repo.putAccount(
      Account.parse({ id: "acc_1", domain: "figma.com", name: "Figma", firmographic: { tech: [] }, tier: "STRONG_FIT", score: 88 }),
    );
    await repo.putAccount(
      Account.parse({ id: "acc_2", domain: "airtable.com", name: "Airtable", firmographic: { tech: [] } }), // no tier: not yet scored
    );

    // 1 decision (account-activation half of the funnel)
    await repo.putDecision(
      Decision.parse({
        id: "dec_1",
        accountId: "acc_1",
        ts: now,
        score: 88,
        tier: "STRONG_FIT",
        relevantSignals: [{ signalId: "sig_1", why: "evaluating collaboration infra" }],
        buyingCommittee: [],
        nextBestAction: { action: "email", channel: "email", targetMember: "VP Eng" },
        rationale: "high intent",
        byAgent: "gtm-router",
        mode: "copilot",
      }),
    );

    // 3 drafts across BOTH workflows:
    //  - dr_1, dr_2: outreach_email, refId=acc_1 (account-activation half)
    //  - dr_3: partner_email, refId=rev_1 (content-review half — must NOT leak into tier conversion)
    await repo.putDraft(
      Draft.parse({ id: "dr_1", kind: "outreach_email", refId: "acc_1", body: "hi", createdBy: "copywriter", createdAt: now }),
    );
    await repo.setDraftStatus("dr_1", "approved");
    await repo.setDraftStatus("dr_1", "dispatched"); // simulates dispatchDraft's status transition

    await repo.putDraft(
      Draft.parse({ id: "dr_2", kind: "outreach_email", refId: "acc_1", body: "hi again", createdBy: "copywriter", createdAt: now }),
    );
    // dr_2 stays "pending" — never approved.

    await repo.putDraft(
      Draft.parse({ id: "dr_3", kind: "partner_email", refId: "rev_1", body: "partner note", createdBy: "reviewer", createdAt: now }),
    );
    await repo.setDraftStatus("dr_3", "approved");

    // Outcomes for dr_1 only: dispatched (sent) + a reply. No meeting outcome anywhere.
    await repo.putOutcome(Outcome.parse({ id: "out_1", refType: "draft", refId: "dr_1", result: "sent", ts: now }));
    await repo.putOutcome(Outcome.parse({ id: "out_2", refType: "draft", refId: "dr_1", result: "replied", ts: now }));

    // 2 reviews: one RETURNED with 2 claim-drift findings, one APPROVED with none.
    await repo.putReview(
      Review.parse({
        id: "rev_1",
        assetId: "asset_1",
        partnerId: "partner_1",
        partnerTier: "Select",
        score: 2,
        changesCount: 4,
        verdict: "RETURNED",
        createdAt: now,
        findings: [
          {
            id: "f1",
            reviewId: "rev_1",
            category: "guaranteed_outcome",
            required: true,
            quote: "guarantees 10x ROI",
            recommendedChange: "remove the guarantee",
            supportingPassageId: null,
            detectedBy: "deterministic",
            severity: "high",
          },
          {
            id: "f2",
            reviewId: "rev_1",
            category: "uncited_quantitative",
            required: false,
            quote: "40% faster",
            recommendedChange: "cite the source",
            supportingPassageId: null,
            detectedBy: "deterministic",
            severity: "low",
          },
        ],
      }),
    );
    await repo.putReview(
      Review.parse({
        id: "rev_2",
        assetId: "asset_2",
        partnerId: "partner_2",
        partnerTier: "Elite",
        score: 5,
        changesCount: 0,
        verdict: "APPROVED",
        createdAt: now,
        findings: [],
      }),
    );
  });

  afterEach(async () => {
    await repo.close();
  });

  it("funnelReport counts every stage correctly and computes stage-to-stage conversion", async () => {
    const report = await funnelReport(repo, { now: FIXED_NOW });
    const byKey = Object.fromEntries(report.stages.map((s) => [s.key, s]));

    expect(byKey["signalsIngested"]?.count).toBe(2);
    expect(byKey["signalsIngested"]?.conversionFromPrevious).toBeNull();

    expect(byKey["accountsScored"]?.count).toBe(1); // only acc_1 has a tier
    expect(byKey["accountsScored"]?.conversionFromPrevious).toBeCloseTo(1 / 2);

    expect(byKey["decisionsMade"]?.count).toBe(1);
    expect(byKey["decisionsMade"]?.conversionFromPrevious).toBeCloseTo(1 / 1);

    expect(byKey["draftsCreated"]?.count).toBe(3); // dr_1, dr_2, dr_3 — both workflows
    expect(byKey["draftsCreated"]?.conversionFromPrevious).toBeCloseTo(3 / 1);

    expect(byKey["draftsApproved"]?.count).toBe(2); // dr_1 (dispatched) + dr_3 (approved); dr_2 still pending
    expect(byKey["draftsApproved"]?.conversionFromPrevious).toBeCloseTo(2 / 3);

    expect(byKey["dispatched"]?.count).toBe(1); // only dr_1 has a "sent" outcome
    expect(byKey["dispatched"]?.conversionFromPrevious).toBeCloseTo(1 / 2);

    expect(byKey["replied"]?.count).toBe(1); // dr_1's reply
    expect(byKey["replied"]?.conversionFromPrevious).toBeCloseTo(1 / 1);

    expect(byKey["meeting"]?.count).toBe(0); // no meeting outcome producer wired yet
    expect(byKey["meeting"]?.conversionFromPrevious).toBe(0);
  });

  it("conversionByTier attributes drafts/sent/replied to the right tier and never leaks non-account drafts", async () => {
    const report = await conversionByTier(repo, { now: FIXED_NOW });
    const byTier = Object.fromEntries(report.tiers.map((t) => [t.tier, t]));

    const strong = byTier["STRONG_FIT"];
    expect(strong?.draftsCreated).toBe(2); // dr_1 + dr_2 (both refId=acc_1); dr_3 (refId=rev_1) excluded
    expect(strong?.sent).toBe(1);
    expect(strong?.replied).toBe(1);
    expect(strong?.meeting).toBe(0);
    expect(strong?.sentRate).toBeCloseTo(1 / 2);
    expect(strong?.repliedRate).toBeCloseTo(1 / 1);
    expect(strong?.meetingRate).toBe(0);

    for (const tierName of ["FIT", "PARTIAL_FIT", "DISQUALIFIED"] as const) {
      const tier = byTier[tierName];
      expect(tier?.draftsCreated).toBe(0);
      expect(tier?.sent).toBe(0);
      expect(tier?.sentRate).toBe(0);
    }
  });

  it("reviewOutcomes tallies verdicts + ranks claim-drift categories, respecting topCategories", async () => {
    const report = await reviewOutcomes(repo, { now: FIXED_NOW });
    expect(report.totalReviews).toBe(2);
    expect(report.approvalRate).toBeCloseTo(1 / 2);
    expect(report.verdicts.find((v) => v.verdict === "APPROVED")?.count).toBe(1);
    expect(report.verdicts.find((v) => v.verdict === "RETURNED")?.count).toBe(1);

    // Both findings occur exactly once each — assert as a set (SQL tie-break order on
    // equal counts is not something this test should depend on).
    const categories = report.topClaimDriftCategories.map((c) => c.category).sort();
    expect(categories).toEqual(["guaranteed_outcome", "uncited_quantitative"]);
    for (const c of report.topClaimDriftCategories) {
      expect(c.count).toBe(1);
    }

    const truncated = await reviewOutcomes(repo, { now: FIXED_NOW, topCategories: 1 });
    expect(truncated.topClaimDriftCategories).toHaveLength(1);
  });

  it("buildGtmReport bundles all three, and formatReport renders a readable combined table", async () => {
    const report = await buildGtmReport(repo, { now: FIXED_NOW });
    expect(report.funnel.generatedAt).toBe(now);
    expect(report.tiers.generatedAt).toBe(now);
    expect(report.reviews.generatedAt).toBe(now);

    const text = formatReport(report);
    expect(text).toContain("Signals ingested");
    expect(text).toContain("STRONG_FIT");
    expect(text).toContain("Total reviews: 2");
    expect(text).toContain("guaranteed_outcome");
  });
});
