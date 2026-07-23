import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Signal,
  Account,
  Claim,
  Guideline,
  Review,
  Decision,
  Draft,
  Outcome,
  GENESIS_HASH,
} from "@mstack/core";

import { openMemory, canonicalJson } from "./index.js";
import type { MemoryRepo } from "./index.js";

const now = "2026-07-20T00:00:00.000Z";

describe("MemoryRepo — DuckDB-backed compounding warehouse", () => {
  let repo: MemoryRepo;

  beforeEach(async () => {
    // Fresh in-memory DB per test — openMemory() never caches internally.
    repo = await openMemory(":memory:");
  });

  afterEach(async () => {
    await repo.close();
  });

  it("round-trips a Signal and finds it by account", async () => {
    const signal = Signal.parse({
      id: "sig_1",
      ts: now,
      source: "sample",
      kind: "product_usage",
      actor: { company: "figma.com" },
      action: "opened_docs",
    });
    await repo.putSignal(signal);

    const found = await repo.getSignalsForAccount("figma.com");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("sig_1");
    expect(await repo.getSignalsForAccount("nope.com")).toHaveLength(0);
  });

  it("round-trips an Account", async () => {
    const account = Account.parse({
      id: "acc_1",
      domain: "figma.com",
      name: "Figma",
      firmographic: { employees: 1500, tech: ["react"] },
    });
    await repo.putAccount(account);

    const found = await repo.getAccount("acc_1");
    expect(found?.name).toBe("Figma");
    expect(found?.buyingCommittee).toEqual([]);
    expect(await repo.getAccount("does-not-exist")).toBeNull();
  });

  it("round-trips a Claim, queryable by assetId", async () => {
    const claim = Claim.parse({ id: "c1", assetId: "as1", text: "10x ROI", checkWorthy: true });
    await repo.putClaim(claim);

    const found = await repo.getClaimsForAsset("as1");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("10x ROI");
  });

  it("round-trips a Guideline, filterable by type", async () => {
    const guideline = Guideline.parse({
      id: "g1",
      category: "uncited_quantitative",
      type: "denylist",
      content: "no uncited stats",
      source: "seed",
    });
    await repo.putGuideline(guideline);

    const found = await repo.listGuidelines({ type: "denylist" });
    expect(found.map((g) => g.id)).toContain("g1");
    expect(await repo.listGuidelines({ type: "allowlist" })).toHaveLength(0);
  });

  it("round-trips a Review and denormalizes its Findings for cross-review queries", async () => {
    const review = Review.parse({
      id: "r1",
      assetId: "as1",
      partnerId: "p1",
      partnerTier: "Select",
      score: 2,
      changesCount: 4,
      verdict: "RETURNED",
      createdAt: now,
      findings: [
        {
          id: "f1",
          reviewId: "r1",
          category: "guaranteed_outcome",
          required: true,
          quote: "guarantees 10x ROI",
          recommendedChange: "remove the guarantee",
          supportingPassageId: null,
          detectedBy: "deterministic",
          severity: "high",
        },
      ],
    });
    await repo.putReview(review);

    const reviews = await repo.listReviews({ partnerId: "p1" });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.verdict).toBe("RETURNED");

    const findings = await repo.getFindingsForReview("r1");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("guaranteed_outcome");

    // re-persisting the review with fewer findings must not leave orphans behind
    await repo.putReview({ ...review, findings: [] });
    expect(await repo.getFindingsForReview("r1")).toHaveLength(0);
  });

  it("round-trips a Decision, queryable via the generic escape hatch", async () => {
    const decision = Decision.parse({
      id: "d1",
      accountId: "acc_1",
      ts: now,
      score: 76,
      tier: "FIT",
      relevantSignals: [{ signalId: "sig_1", why: "evaluating collaboration infra" }],
      buyingCommittee: [],
      nextBestAction: { action: "email", channel: "email", targetMember: "VP Eng" },
      rationale: "high intent",
      byAgent: "gtm-router",
      mode: "copilot",
    });
    await repo.putDecision(decision);

    const rows = await repo.query<{ id: string }>(
      "SELECT id FROM decisions WHERE account_id = $accountId",
      { accountId: "acc_1" },
    );
    expect(rows.map((r) => r.id)).toContain("d1");
  });

  it("round-trips a Draft and transitions its status", async () => {
    const draft = Draft.parse({
      id: "dr1",
      kind: "outreach_email",
      refId: "acc_1",
      body: "hi",
      createdBy: "copywriter",
      createdAt: now,
    });
    await repo.putDraft(draft);
    expect((await repo.getDraft("dr1"))?.status).toBe("pending"); // never auto-approved

    await repo.setDraftStatus("dr1", "approved");
    expect((await repo.getDraft("dr1"))?.status).toBe("approved");

    await expect(repo.setDraftStatus("no-such-draft", "approved")).rejects.toThrow();
  });

  it("claimDraftForDispatch atomically claims approved->dispatched exactly once (#7)", async () => {
    const draft = Draft.parse({
      id: "dr_claim",
      kind: "outreach_email",
      refId: "acc_1",
      body: "hi",
      createdBy: "copywriter",
      createdAt: now,
    });
    await repo.putDraft(draft);
    await repo.setDraftStatus("dr_claim", "approved");

    // first claim wins and flips BOTH the column and the JSON data to 'dispatched'.
    expect(await repo.claimDraftForDispatch("dr_claim")).toBe(true);
    expect((await repo.getDraft("dr_claim"))?.status).toBe("dispatched");

    // second claim loses — the row is no longer 'approved' (this is what makes concurrent
    // dispatchers safe: exactly one UPDATE can move approved->dispatched).
    expect(await repo.claimDraftForDispatch("dr_claim")).toBe(false);

    // a draft that isn't 'approved' cannot be claimed; nor can a missing one.
    await repo.putDraft(
      Draft.parse({ id: "dr_pending", kind: "outreach_email", refId: "acc_1", body: "hi", createdBy: "c", createdAt: now }),
    );
    expect(await repo.claimDraftForDispatch("dr_pending")).toBe(false);
    expect(await repo.claimDraftForDispatch("no-such-draft")).toBe(false);
  });

  it("round-trips an Outcome", async () => {
    const outcome = Outcome.parse({ id: "o1", refType: "draft", refId: "dr1", result: "sent", ts: now });
    await repo.putOutcome(outcome);

    const rows = await repo.query<{ id: string }>("SELECT id FROM outcomes WHERE ref_id = $refId", {
      refId: "dr1",
    });
    expect(rows.map((r) => r.id)).toContain("o1");
  });

  it("hash-chains Approvals in order and verifies the chain", async () => {
    const a1 = await repo.appendApproval({ id: "ap1", draftId: "dr1", decision: "approve", actor: "human", ts: now });
    const a2 = await repo.appendApproval({
      id: "ap2",
      draftId: "dr2",
      decision: "reject",
      actor: "human",
      ts: now,
      note: "off-brand",
    });
    const a3 = await repo.appendApproval({ id: "ap3", reviewId: "r1", decision: "edit", actor: "human", ts: now });

    expect(a1.prevHash).toBe(GENESIS_HASH);
    expect(a2.prevHash).toBe(a1.hash);
    expect(a3.prevHash).toBe(a2.hash);
    expect(await repo.verifyAuditChain()).toBe(true);
  });

  it("detects tampering with a previously-written Approval", async () => {
    await repo.appendApproval({ id: "ap1", draftId: "dr1", decision: "approve", actor: "human", ts: now });
    await repo.appendApproval({ id: "ap2", draftId: "dr2", decision: "approve", actor: "human", ts: now });
    expect(await repo.verifyAuditChain()).toBe(true);

    // Simulate an attacker rewriting history directly (bypassing appendApproval,
    // so the stored hash is left stale relative to the tampered payload). A hex
    // sha256 digest can never contain "approve" (p/r/o/v aren't hex digits), so
    // this only touches the `decision` field, not the hash itself.
    await repo.query("UPDATE approvals SET data = REPLACE(data, 'approve', 'reject') WHERE id = $id", {
      id: "ap1",
    });

    expect(await repo.verifyAuditChain()).toBe(false);
  });

  it("hashes the canonical PARSED approval, so an input with an extra field still yields a verifiable chain (#12)", async () => {
    // A caller passes a field the Approval schema does not define (e.g. from untrusted/
    // deserialized input). It must be stripped BEFORE hashing — otherwise the stored row
    // (extras stripped by Approval.parse) can never be recomputed to its own stored hash,
    // permanently breaking verifyAuditChain.
    await repo.appendApproval({
      id: "ap1",
      draftId: "dr1",
      decision: "approve",
      actor: "human",
      ts: now,
      extraneous: "stripped before hashing",
    } as unknown as Parameters<MemoryRepo["appendApproval"]>[0]);
    // a normal row chained off it — proves the linkage still holds through the stripped row.
    await repo.appendApproval({ id: "ap2", draftId: "dr2", decision: "approve", actor: "human", ts: now });

    expect(await repo.verifyAuditChain()).toBe(true);

    // the extra field was stripped, not persisted.
    const rows = await repo.query<{ data: string }>("SELECT data FROM approvals WHERE id = $id", {
      id: "ap1",
    });
    const stored = JSON.parse(String(rows[0]?.data)) as Record<string, unknown>;
    expect(stored.extraneous).toBeUndefined();
  });

  it("auditHead pins the chain head; verifyAuditChain(expected) detects tail-truncation the chain alone cannot (#8)", async () => {
    await repo.appendApproval({ id: "ap1", draftId: "dr1", decision: "approve", actor: "human", ts: now });
    const a2 = await repo.appendApproval({ id: "ap2", draftId: "dr2", decision: "approve", actor: "human", ts: now });

    const head = await repo.auditHead();
    expect(head.count).toBe(2);
    expect(head.headHash).toBe(a2.hash);
    expect(await repo.verifyAuditChain(head)).toBe(true);

    // Delete the NEWEST row (tail truncation). The surviving prefix is still internally
    // consistent, so the plain chain check cannot see it...
    await repo.query("DELETE FROM approvals WHERE id = $id", { id: "ap2" });
    expect(await repo.verifyAuditChain()).toBe(true);
    // ...but comparing against the pinned head catches it (count dropped, head moved).
    expect(await repo.verifyAuditChain(head)).toBe(false);

    // empty chain -> genesis head, count 0.
    await repo.query("DELETE FROM approvals");
    expect(await repo.auditHead()).toEqual({ count: 0, headHash: GENESIS_HASH });
  });

  it("canonicalJson is deterministic regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { d: 1, c: 2 }, b: [3, 2, 1] })).toBe('{"a":{"c":2,"d":1},"b":[3,2,1]}');
  });
});
