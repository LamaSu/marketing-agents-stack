/**
 * commands.ts — the smaller subcommands: approve (the one send path), list,
 * review <file>, score <domain>. seed/demo live in their own modules.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { Account, ReviewRequest, newId } from "@mstack/core";
import { SampleSource } from "@mstack/adapters-signals";
import { SampleProvider } from "@mstack/adapters-enrichment";
import { RulesScorer } from "@mstack/adapters-scoring";
import { LocalOutreachChannel, approveAndDispatch } from "@mstack/runtime";
import { reviewAsset } from "@mstack/reviewer";

import type { CliContext } from "./context.js";
import { buildLiveCorpus, loadGuidelines, offlineReviewResult } from "./reviewers.js";
import { printApproveResult, printPendingList, printReviewResult, printScoreResult } from "./format.js";

/**
 * `mstack approve <draftId>` — approve + dispatch through the one gated path
 * (`approveAndDispatch`), then verify the hash-chained audit trail. This is the
 * ONLY way a draft reaches the outbox.
 */
export async function runApprove(ctx: CliContext, draftId: string): Promise<void> {
  const channel = new LocalOutreachChannel(ctx.paths.outboxDir);
  const outcome = await approveAndDispatch(draftId, "demo-user", channel, {
    memory: ctx.memory,
    draftStore: ctx.draftStore,
  });
  const draft = await ctx.memory.getDraft(draftId);
  printApproveResult(draftId, outcome, draft);
  const verified = await ctx.memory.verifyAuditChain();
  console.log(`  audit chain verified: ${verified}`);
}

/** `mstack list` — drafts awaiting approval. */
export async function runList(ctx: CliContext): Promise<void> {
  const pending = await ctx.draftStore.listPending();
  printPendingList(pending);
}

/** `mstack review <file>` — review one asset (.json ReviewRequest or raw text). */
export async function runReviewFile(ctx: CliContext, file: string): Promise<void> {
  const text = await readFile(file, "utf8");
  const req = file.endsWith(".json")
    ? ReviewRequest.parse(JSON.parse(text))
    : ReviewRequest.parse({
        partnerId: "unknown-partner",
        partnerTier: "Registered",
        contentTitle: basename(file),
        contentType: "other",
        content: text,
      });

  const result =
    ctx.mode === "live"
      ? await reviewAsset(req, { corpus: await buildLiveCorpus(ctx.paths.lanceDir) })
      : offlineReviewResult(req, await loadGuidelines(ctx.memory));

  printReviewResult(req.contentTitle, result);
}

/** `mstack score <domain>` — rules-only ICP score for one account (self-contained). */
export async function runScoreDomain(_ctx: CliContext, domain: string): Promise<void> {
  const normalized = domain.trim().toLowerCase();
  const enrichment = await new SampleProvider().enrich({ domain: normalized });
  const signals = (await new SampleSource().pull()).filter(
    (s) => s.actor.company?.trim().toLowerCase() === normalized,
  );

  const account = Account.parse({
    id: newId("acc"),
    domain: normalized,
    name: enrichment?.name ?? normalized,
    firmographic: enrichment?.firmographic ?? { tech: [] },
    provenance: enrichment?.provenance ?? {},
    signalRefs: signals.map((s) => s.id),
    buyingCommittee: enrichment?.contacts ?? [],
    lastScoredAt: null,
  });

  const score = await new RulesScorer().score(account, signals);
  printScoreResult(normalized, score);
}
