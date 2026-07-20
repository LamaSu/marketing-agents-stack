import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Draft, Review, ReviewRequest } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "../draft-store.js";
import { runContentReview } from "./content-review.js";
import type { ReviewFn } from "./content-review.js";

const now = "2026-07-20T00:00:00.000Z";

const REQUEST: ReviewRequest = ReviewRequest.parse({
  partnerId: "partner_1",
  partnerTier: "Select",
  contentTitle: "Q3 case study",
  contentType: "case_study",
  content: "We guarantee 10x ROI in 30 days.",
});

function cannedReviewFn(): ReviewFn {
  return async (req) => {
    const review = Review.parse({
      id: "rev_1",
      assetId: "asset_1",
      partnerId: req.partnerId,
      partnerTier: req.partnerTier,
      score: 2,
      changesCount: 1,
      verdict: "RETURNED",
      createdAt: now,
      findings: [
        {
          id: "f1",
          reviewId: "rev_1",
          category: "guaranteed_outcome",
          required: true,
          quote: "guarantee 10x ROI",
          recommendedChange: "remove the guarantee",
          supportingPassageId: null,
          detectedBy: "deterministic",
          severity: "high",
        },
      ],
    });
    const partnerEmail = Draft.parse({
      id: "dr_email_1",
      kind: "partner_email",
      refId: "rev_1",
      subject: "Content review — RETURNED",
      body: "Please address the required change.",
      createdBy: "reviewer",
      createdAt: now,
    });
    const reviewExport = Draft.parse({
      id: "dr_export_1",
      kind: "review_export",
      refId: "rev_1",
      subject: "Annotated review",
      body: "Findings: guaranteed_outcome...",
      channel: "export",
      createdBy: "reviewer",
      createdAt: now,
    });
    return { review, partnerEmail, reviewExport };
  };
}

describe("runContentReview", () => {
  let memory: MemoryRepo;
  let draftsDir: string;
  let outboxDir: string;
  let draftStore: DraftStore;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-runtime-cr-drafts-"));
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-runtime-cr-outbox-"));
    draftStore = new DraftStore(memory, draftsDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("produces 2 pending drafts + a persisted Review, and dispatches nothing", async () => {
    const result = await runContentReview(REQUEST, {
      memory,
      draftStore,
      reviewFn: cannedReviewFn(),
    });

    // 2 pending drafts.
    expect(result.drafts.partnerEmail.status).toBe("pending");
    expect(result.drafts.reviewExport.status).toBe("pending");
    const persistedEmail = await memory.getDraft(result.drafts.partnerEmail.id);
    const persistedExport = await memory.getDraft(result.drafts.reviewExport.id);
    expect(persistedEmail?.status).toBe("pending");
    expect(persistedExport?.status).toBe("pending");

    // a persisted Review.
    expect(result.review.verdict).toBe("RETURNED");
    const reviews = await memory.listReviews({ partnerId: "partner_1" });
    expect(reviews.map((r) => r.id)).toContain("rev_1");

    // dispatches NOTHING: no Outcome row, outbox stays empty.
    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes",
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(0);
    expect(await readdir(outboxDir)).toEqual([]);

    // no Approval was ever appended either — this workflow only ever produces drafts.
    const approvalRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM approvals",
    );
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
  });

  it("writes the draft-first artifacts to disk via draftStore.save (drafts/<id>.json)", async () => {
    const result = await runContentReview(REQUEST, {
      memory,
      draftStore,
      reviewFn: cannedReviewFn(),
    });

    const files = await readdir(draftsDir);
    expect(files).toContain(`${result.drafts.partnerEmail.id}.json`);
    expect(files).toContain(`${result.drafts.reviewExport.id}.json`);
  });
});
