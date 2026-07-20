import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ReviewResult, scoreForChanges } from "@mstack/core";
import type { ClaimCategory, Guideline, ReviewRequest } from "@mstack/core";
import type { AnthropicClient } from "@mstack/agents";

import {
  reviewAsset,
  authorGuidelines,
  buildReviewDrafts,
  createLanceCorpus,
  FakeEmbedder,
  loadFullGuidelineCorpus,
  loadReviewRequests,
} from "./index.js";
import type { LanceCorpus } from "./index.js";

/* ── offline fake Anthropic client (mirrors run-agent.test.ts) ─────────────
 * Every runAgent call in the reviewer pipeline is a single, tool-free
 * messages.create → one final JSON turn. The pipeline makes exactly two model
 * calls (extract, then judge), so a two-response queue drives a full
 * reviewAsset with no network. */
function msg(content: unknown[], stopReason: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}
const text = (t: string): Anthropic.Message => msg([{ type: "text", text: t }], "end_turn");

class FakeClient implements AnthropicClient {
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly queue: Anthropic.Message[];
  constructor(responses: Anthropic.Message[]) {
    this.queue = [...responses];
  }
  messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message> => {
      this.calls.push(params);
      const next = this.queue.shift();
      if (!next) throw new Error("FakeClient: no scripted response left");
      return next;
    },
  };
}

const SIX_CATEGORIES: ClaimCategory[] = [
  "guaranteed_outcome",
  "uncited_quantitative",
  "unapproved_superlative",
  "unapproved_spokesperson_quote",
  "roadmap_disclosure",
  "badge_tier_misuse",
];

describe("reviewAsset — the Claude agent pipeline, offline (fake client + fake embedder + real sample corpus)", () => {
  let guidelines: Guideline[];
  let assets: ReviewRequest[];
  let corpus: LanceCorpus;
  let dbDir: string;

  beforeAll(async () => {
    guidelines = await loadFullGuidelineCorpus();
    assets = await loadReviewRequests();
    // A real temp dir + FakeEmbedder — offline, no network, no model download
    // (same corpus-construction idiom as lance-corpus.test.ts). The embedder is
    // injected INTO the corpus, satisfying "the embedder is injectable".
    dbDir = await mkdtemp(join(tmpdir(), "mstack-reviewer-agent-"));
    corpus = createLanceCorpus({ dbPath: dbDir, embedder: new FakeEmbedder() });
    await corpus.ingest(guidelines);
  });

  afterAll(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  function asset(partnerId: string): ReviewRequest {
    const found = assets.find((a) => a.partnerId === partnerId);
    if (!found) throw new Error(`fixture asset not found: ${partnerId}`);
    return found;
  }

  /* ── the DIRTY ABC Corp asset: RETURNED, all six categories, rubric score ── */

  it("on the dirty ABC Corp asset → verdict RETURNED, the six categories present, score per rubric", async () => {
    const abc = asset("ABC Corp");
    const extract = text(
      JSON.stringify({
        claims: [
          { text: "KLZ Orchestrate guarantees a 10x ROI in the first year", category: "guaranteed_outcome", checkWorthy: true },
          { text: "no other platform on the market comes close", category: "unapproved_superlative", checkWorthy: true },
          { text: "This partnership represents the future of agentic commerce", category: "unapproved_spokesperson_quote", checkWorthy: true },
          { text: "KLZ will be launching its Agent Marketplace in Q4 2026", category: "roadmap_disclosure", checkWorthy: true },
        ],
      }),
    );
    // The fake judge returns the planted findings (one per category).
    const judgeFindings = [
      { category: "guaranteed_outcome", required: true, quote: "guarantees a 10x ROI", recommendedChange: "Remove the guarantee language; cite a customer-reported result or drop the claim.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
      { category: "uncited_quantitative", required: true, quote: "10x ROI", recommendedChange: "Cite a published source for the 10x figure, or remove it.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
      { category: "unapproved_superlative", required: true, quote: "no other platform on the market comes close", recommendedChange: "Remove the comparative superlative; describe the capability concretely.", supportingPassageId: null, detectedBy: "claude", severity: "medium" },
      { category: "unapproved_spokesperson_quote", required: true, quote: "This partnership represents the future of agentic commerce", recommendedChange: "Remove the quote attributed to Morgan Hale, or obtain written KLZ approval.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
      { category: "roadmap_disclosure", required: true, quote: "Agent Marketplace", recommendedChange: "Remove the reference to the unannounced Agent Marketplace roadmap item.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
      { category: "badge_tier_misuse", required: true, quote: "Powered by KLZ Orchestrate", recommendedChange: "Use the Select-tier designation; the Powered-by badge is Elite-only.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
    ];
    const judgeResp = text(JSON.stringify({ findings: judgeFindings, summary: "Multiple required changes across all six categories; return to the partner." }));
    const client = new FakeClient([extract, judgeResp]);

    const result = await reviewAsset(abc, { corpus, client });

    // exactly two model calls: extract (sonnet) + judge (opus); no tools, no re-ask
    expect(client.calls.length).toBe(2);

    expect(result.verdict).toBe("RETURNED");
    const cats = new Set(result.findings.map((f) => f.category));
    for (const c of SIX_CATEGORIES) expect(cats.has(c)).toBe(true);

    // score is the core rubric applied to the REQUIRED-change count (not model-chosen)
    expect(result.changesCount).toBeGreaterThanOrEqual(5);
    expect(result.score).toBe(scoreForChanges(result.changesCount));
    expect(result.score).toBe(1); // 5+ required changes → score 1
  });

  /* ── the CLEAN Northland asset: APPROVED, zero required findings ──────────
   * Also a pipeline-level guard on the STEP-0 fix: before it, the deterministic
   * pre-scan false-flagged Northland's approved "automates document-heavy
   * workflows across finance, legal, and operations" phrasing as an unapproved
   * superlative, which would make this RETURNED, changesCount 1. */

  it("on the clean Northland asset → verdict APPROVED, zero required findings", async () => {
    const nl = asset("Northland Analytics");
    const extract = text(
      JSON.stringify({
        claims: [
          { text: "teams reported a median 22% reduction in manual pipeline triage", category: "uncited_quantitative", checkWorthy: true },
          { text: "Northland Analytics is a proud KLZ Elite partner", category: null, checkWorthy: false },
        ],
      }),
    );
    const judgeResp = text(JSON.stringify({ findings: [], summary: "No drift: the 22% figure is cited to a published source and the Elite badge matches the partner tier." }));
    const client = new FakeClient([extract, judgeResp]);

    const result = await reviewAsset(nl, { corpus, client });

    expect(result.verdict).toBe("APPROVED");
    expect(result.changesCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.score).toBe(5);
  });

  /* ── guardrail #1: no marketing prose; recommendedChange is an instruction ── */

  it("ReviewResult carries only findings + summary + score (no generated-prose field); every recommendedChange is a short instruction", async () => {
    const abc = asset("ABC Corp");
    const extract = text(JSON.stringify({ claims: [{ text: "KLZ Orchestrate guarantees a 10x ROI", category: "guaranteed_outcome", checkWorthy: true }] }));
    const judgeResp = text(
      JSON.stringify({
        findings: [
          { category: "uncited_quantitative", required: true, quote: "10x", recommendedChange: "Cite a published source for the 10x figure, or remove it.", supportingPassageId: null, detectedBy: "claude", severity: "high" },
        ],
        summary: "One required change: the 10x figure needs a citation.",
      }),
    );
    const client = new FakeClient([extract, judgeResp]);
    const result = await reviewAsset(abc, { corpus, client });

    // guardrail #1 as a TYPE: the whole result is findings + a reviewer note + a
    // score. There is no field anywhere for generated/replacement marketing copy.
    expect(new Set(Object.keys(result))).toEqual(new Set(["score", "changesCount", "verdict", "findings", "summary"]));

    const ALLOWED_FINDING_KEYS = new Set([
      "category",
      "required",
      "quote",
      "span",
      "recommendedChange",
      "supportingPassageId",
      "detectedBy",
      "severity",
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      for (const key of Object.keys(f)) expect(ALLOWED_FINDING_KEYS.has(key)).toBe(true);
      // an instruction, not a rewritten marketing paragraph
      expect(f.recommendedChange.length).toBeGreaterThan(0);
      expect(f.recommendedChange.length).toBeLessThan(320);
      // and it never reproduces the asset's promotional copy verbatim
      expect(f.recommendedChange).not.toContain("no other platform on the market comes close");
    }
  });

  /* ── authorGuidelines: brand brief → core Guideline[] via a sonnet call ──── */

  it("authorGuidelines turns a brand brief into a validated core Guideline[] (the six-category rule-set + starter approved messaging)", async () => {
    const authored = [
      { id: "acme-lex-guarantee-1", category: "guaranteed_outcome", type: "lexicon", content: "Never use 'guarantee', 'guaranteed', or 'ensures' about customer outcomes.", severity: "high", source: "acme-brief", version: "1" },
      { id: "acme-lex-superlative-1", category: "unapproved_superlative", type: "lexicon", content: "Avoid 'best-in-class' and 'unmatched'; describe the capability concretely instead.", severity: "medium", source: "acme-brief", version: "1" },
      { id: "acme-lex-quant-1", category: "uncited_quantitative", type: "lexicon", content: "Any percentage or multiplier claim needs a cited published source.", severity: "high", source: "acme-brief", version: "1" },
      { id: "acme-deny-roadmap-1", category: "roadmap_disclosure", type: "denylist", content: "Do not reference unreleased features or internal codenames.", severity: "high", source: "acme-brief", version: "1" },
      { id: "acme-allow-spokes-1", category: "unapproved_spokesperson_quote", type: "allowlist", content: "Approved spokesperson: Jane Doe (VP Marketing).", severity: "high", source: "acme-brief", version: "1" },
      { id: "acme-tier-1", category: "badge_tier_misuse", type: "tier_map", content: "Elite -> 'Powered by Acme'; Registered -> no badge.", severity: "medium", source: "acme-brief", version: "1" },
      { id: "acme-msg-1", category: "positioning", type: "approved_messaging", content: "Acme connects agents to your systems of record without a rebuild.", severity: "low", source: "acme-brief", version: "1" },
    ];
    const client = new FakeClient([text(JSON.stringify({ guidelines: authored }))]);

    const result = await authorGuidelines(
      "Acme is a data platform. Avoid guarantees and unapproved superlatives. Approved spokesperson: Jane Doe.",
      { client },
    );

    expect(client.calls.length).toBe(1);
    expect(result.length).toBe(authored.length);
    expect(result.every((g) => typeof g.id === "string" && g.id.length > 0)).toBe(true);
    const types = new Set(result.map((g) => g.type));
    expect(types.has("lexicon")).toBe(true);
    expect(types.has("denylist")).toBe(true);
    expect(types.has("allowlist")).toBe(true);
    expect(types.has("tier_map")).toBe(true);
    expect(types.has("approved_messaging")).toBe(true);
  });

  /* ── buildReviewDrafts: two pending draft-first PROCESS artifacts ─────────── */

  it("buildReviewDrafts produces two pending drafts (partner email + review export) that carry findings/instructions, not regenerated marketing copy", () => {
    const req = asset("ABC Corp");
    const review = ReviewResult.parse({
      score: 1,
      changesCount: 2,
      verdict: "RETURNED",
      findings: [
        { category: "uncited_quantitative", required: true, quote: "10x", recommendedChange: "Cite a published source for the 10x figure, or remove it.", supportingPassageId: null, detectedBy: "deterministic", severity: "high" },
        { category: "badge_tier_misuse", required: true, quote: "Powered by KLZ Orchestrate", recommendedChange: "Use the Select-tier designation; the Powered-by badge is Elite-only.", supportingPassageId: null, detectedBy: "deterministic", severity: "high" },
      ],
      summary: "Two required changes before this can be published.",
    });

    const { partnerEmail, reviewExport } = buildReviewDrafts(review, req, {
      reviewId: "rev-abc-1",
      now: "2026-07-20T00:00:00.000Z",
    });

    // draft-first (guardrail #2): both land pending — nothing sends from here.
    expect(partnerEmail.status).toBe("pending");
    expect(reviewExport.status).toBe("pending");
    expect(partnerEmail.kind).toBe("partner_email");
    expect(reviewExport.kind).toBe("review_export");
    expect(partnerEmail.refId).toBe("rev-abc-1");
    expect(reviewExport.refId).toBe("rev-abc-1");
    expect(partnerEmail.createdAt).toBe("2026-07-20T00:00:00.000Z");

    // process artifacts: they surface each finding's recommended change (an
    // instruction), not a rewritten marketing paragraph.
    for (const f of review.findings) {
      expect(partnerEmail.body).toContain(f.recommendedChange);
      expect(reviewExport.body).toContain(f.recommendedChange);
    }
    expect(partnerEmail.body).toContain("RETURNED");
    expect(partnerEmail.body).toContain("review instructions only");
  });
});
