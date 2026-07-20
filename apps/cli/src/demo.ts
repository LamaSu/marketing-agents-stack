/**
 * demo.ts — `mstack demo`. Runs BOTH production workflows end-to-end through the
 * runtime (research/06-architecture.md §4, §5.2), mode-appropriately:
 *
 *   - content-review:     for each sample asset → `runContentReview(req, {reviewFn, memory, draftStore})`
 *   - account-activation: for figma.com + airtable.com → `runAccountActivation(input, {activateFn, memory, draftStore})`
 *
 * Everything lands as `pending` drafts under drafts/. DISPATCHES NOTHING: the
 * demo asserts the outbox is empty on the way out (guardrail #2 — a human
 * approves every send; the only way to an outbox entry is `mstack approve`).
 */
import { readdir } from "node:fs/promises";

import { ActivateAccount } from "@mstack/core";
import type { Draft } from "@mstack/core";
import { SampleProvider } from "@mstack/adapters-enrichment";
import { RulesScorer } from "@mstack/adapters-scoring";
import { runAccountActivation, runContentReview } from "@mstack/runtime";
import { loadReviewRequests } from "@mstack/reviewer";

import type { CliContext } from "./context.js";
import { buildLiveCorpus, liveReviewFn, loadGuidelines, offlineReviewFn } from "./reviewers.js";
import { liveActivateFn, offlineActivateFn } from "./activators.js";

/** The two sample accounts activated by the demo. */
export const DEMO_ACCOUNTS: ReadonlyArray<{ domain: string; name: string }> = [
  { domain: "figma.com", name: "Figma" },
  { domain: "airtable.com", name: "Airtable" },
];

export interface ReviewSummary {
  partnerId: string;
  contentTitle: string;
  verdict: string;
  score: number;
  totalFindings: number;
  findingsByCategory: Record<string, number>;
}

export interface DecisionSummary {
  domain: string;
  accountId: string;
  score: number;
  tier: string;
  nextBestAction: string;
  targetMember: string;
  relevantSignalIds: string[];
}

export interface DemoResult {
  mode: CliContext["mode"];
  reviews: ReviewSummary[];
  decisions: DecisionSummary[];
  pendingDrafts: Draft[];
  draftsDir: string;
  outboxCount: number;
}

async function countOutboxSends(outboxDir: string): Promise<number> {
  try {
    const files = await readdir(outboxDir);
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0; // no outbox dir yet == nothing dispatched
  }
}

export async function runDemo(ctx: CliContext): Promise<DemoResult> {
  const { memory, draftStore, mode } = ctx;

  /* ── content-review ─────────────────────────────────────────────────── */
  const reviewFn =
    mode === "live"
      ? liveReviewFn(await buildLiveCorpus(ctx.paths.lanceDir))
      : offlineReviewFn(await loadGuidelines(memory));

  const requests = await loadReviewRequests();
  const reviews: ReviewSummary[] = [];
  for (const req of requests) {
    const { review } = await runContentReview(req, { reviewFn, memory, draftStore });
    const findingsByCategory: Record<string, number> = {};
    for (const f of review.findings) {
      findingsByCategory[f.category] = (findingsByCategory[f.category] ?? 0) + 1;
    }
    reviews.push({
      partnerId: req.partnerId,
      contentTitle: req.contentTitle,
      verdict: review.verdict,
      score: review.score,
      totalFindings: review.findings.length,
      findingsByCategory,
    });
  }

  /* ── account-activation ─────────────────────────────────────────────── */
  const enrichment = new SampleProvider();
  const activateFn =
    mode === "live"
      ? liveActivateFn({ memory, enrichment })
      : offlineActivateFn({ memory, enrichment, scoring: new RulesScorer() });

  const decisions: DecisionSummary[] = [];
  for (const account of DEMO_ACCOUNTS) {
    const input = ActivateAccount.parse({ accountRef: account, mode: "copilot" });
    const { decision } = await runAccountActivation(input, { activateFn, memory, draftStore });
    decisions.push({
      domain: account.domain,
      accountId: decision.accountId,
      score: decision.score,
      tier: decision.tier,
      nextBestAction: decision.nextBestAction.action,
      targetMember: decision.nextBestAction.targetMember,
      relevantSignalIds: decision.relevantSignals.map((s) => s.signalId),
    });
  }

  /* ── drafts + the "nothing was sent" invariant ──────────────────────── */
  const pendingDrafts = await draftStore.listPending();
  const outboxCount = await countOutboxSends(ctx.paths.outboxDir);
  if (outboxCount !== 0) {
    throw new Error(
      `demo invariant violated: outbox holds ${outboxCount} dispatched item(s) — the demo must send NOTHING ` +
        `(guardrail #2: a human approves every send). Only \`mstack approve <draftId>\` may dispatch.`,
    );
  }

  return { mode, reviews, decisions, pendingDrafts, draftsDir: ctx.paths.draftsDir, outboxCount };
}
