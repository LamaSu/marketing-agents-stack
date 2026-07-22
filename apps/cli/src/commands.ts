/**
 * commands.ts — the smaller subcommands: approve (the one send path), list,
 * review <file>, score <domain>. seed/demo live in their own modules.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { Account, Outcome, ReviewRequest, newId } from "@mstack/core";
import type { OutcomeResult } from "@mstack/core";
import { SampleSource } from "@mstack/adapters-signals";
import { SampleProvider } from "@mstack/adapters-enrichment";
import { GaussianProcessQualifier, RulesScorer } from "@mstack/adapters-scoring";
import type { LabeledExample, QualifierCandidate } from "@mstack/adapters-scoring";
import { DirectExecutor, LocalOutreachChannel, approveAndDispatch } from "@mstack/runtime";
import { reviewAsset } from "@mstack/reviewer";
import { exportAuditHalo, writeHaloAudit } from "@mstack/memory";
import { buildGtmReport, type GtmReport } from "@mstack/analytics";
import { ingestOutcomes, sampleOutcomeSource } from "@mstack/adapters-outcomes";
import {
  advanceSequence,
  exampleSequence,
  openSequenceStore,
  startSequenceRun,
  tickSequences,
} from "@mstack/sequences";

import type { CliContext } from "./context.js";
import { buildLiveCorpus, loadGuidelines, offlineReviewResult } from "./reviewers.js";
import {
  printApproveResult,
  printExportAuditResult,
  printIngestOutcomesResult,
  printPendingList,
  printReport,
  printReviewResult,
  printScoreResult,
  printSequenceList,
  printSequenceStartResult,
  printSequenceTickResult,
  printTrainQualifierResult,
} from "./format.js";
import type { TrainQualifierSummary } from "./format.js";

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

export interface ExportAuditOptions {
  /** Only "halo" is implemented (research/10-sota-integration-design.md §2.11, B3). */
  format?: string;
  /** Destination file; omit to print the JSON array to stdout instead. */
  out?: string;
}

/**
 * `mstack export-audit --format halo [--out <file>]` — exports the
 * `approvals` hash chain in halo-record's schema so an EXTERNAL `halo verify`
 * (a separate Python CLI, never vendored here — see
 * `packages/memory/src/halo-export.ts`) can independently confirm the chain.
 * This is an EXPORT only: it never touches the internal welded
 * `appendApproval`/`verifyAuditChain` chain that `mstack approve` writes to.
 */
export async function runExportAudit(ctx: CliContext, opts: ExportAuditOptions): Promise<void> {
  const format = opts.format ?? "halo";
  if (format !== "halo") {
    throw new Error(`export-audit: unsupported --format "${format}" (only "halo" is implemented)`);
  }

  const out = opts.out;
  if (out) {
    const records = await writeHaloAudit(ctx.memory, out);
    printExportAuditResult(records.length, out);
  } else {
    const records = await exportAuditHalo(ctx.memory);
    console.log(JSON.stringify(records, null, 2));
  }
}

/**
 * `mstack ingest-outcomes` — pull the offline sample RETURN LEG (replies / meetings /
 * no-responses) into the warehouse via `ingestOutcomes(sampleOutcomeSource(), memory)`. This
 * is what gives `report` its reply/meeting counts and `train-qualifier` its labels. Offline,
 * idempotent (the underlying `putOutcome` upserts by id), no network, no credentials.
 */
export async function runIngestOutcomes(ctx: CliContext): Promise<void> {
  const result = await ingestOutcomes(sampleOutcomeSource(), ctx.memory);
  printIngestOutcomesResult(result);
}

/**
 * `mstack report` — the GTM funnel + per-tier conversion + review-outcomes dashboard, rendered
 * from the warehouse by `@mstack/analytics` (read-only, deterministic, offline). Safe on an
 * empty warehouse (every count zero-fills).
 */
export async function runReport(ctx: CliContext): Promise<GtmReport> {
  return buildGtmReport(ctx.memory);
}

/**
 * `mstack sequence <start|tick|list>` — the multi-step cadence engine. Every step QUEUES a
 * `pending` draft through the existing draft-first gate; it NEVER sends. A human still approves
 * every draft (`mstack approve <id>`), so a cadence cannot bypass the one send path.
 */
export async function runSequence(ctx: CliContext, sub: string, domain?: string): Promise<void> {
  switch (sub) {
    case "start":
      return runSequenceStart(ctx, domain);
    case "tick":
      return runSequenceTick(ctx);
    case "list":
      return runSequenceList(ctx);
    default:
      throw new Error(
        `sequence: unknown subcommand "${sub}" (expected: start <domain> | tick | list)`,
      );
  }
}

/** Resolve a `<domain>` to an enrollment ref: a persisted Account's id when one exists (so the
 *  queued drafts join to it in the tier analytics), else the domain string itself (still a valid,
 *  fully-approvable enrollment — it just isn't tied to a scored Account yet). */
async function resolveAccountRef(ctx: CliContext, domain: string): Promise<{ ref: string; resolved: boolean }> {
  const rows = await ctx.memory.query<{ data: string }>(
    "SELECT data FROM accounts WHERE domain = $domain",
    { domain },
  );
  const row = rows[0];
  if (row) {
    const account = Account.parse(JSON.parse(String(row.data)));
    return { ref: account.id, resolved: true };
  }
  return { ref: domain, resolved: false };
}

/** `sequence start <domain>` — enroll the account into the bundled 2-step cadence and advance
 *  once. Step-0 (`delayDays: 0`) is due immediately, so advancing queues it as a PENDING draft
 *  awaiting approval. Nothing is sent: `advanceSequence` routes through `DraftStore#save` (the
 *  gate), never `dispatchDraft`. */
async function runSequenceStart(ctx: CliContext, domainArg: string | undefined): Promise<void> {
  const domain = (domainArg ?? "").trim().toLowerCase();
  if (domain.length === 0) {
    throw new Error("sequence start: missing required <domain>. Try: mstack sequence start acme.com");
  }
  const account = await resolveAccountRef(ctx, domain);

  const store = await openSequenceStore(ctx.memory);
  const sequence = await store.saveSequence(exampleSequence());
  const run = await store.saveRun(startSequenceRun(sequence, account.ref));

  const advanced = await advanceSequence(run, {
    memory: ctx.memory,
    drafts: ctx.draftStore,
    store,
    executor: new DirectExecutor(),
  });

  const queuedDraftId = advanced.queuedDraftIds[advanced.queuedDraftIds.length - 1];
  printSequenceStartResult({
    runId: advanced.id,
    sequenceName: sequence.name,
    accountRef: account.ref,
    resolvedFromAccount: account.resolved,
    status: advanced.status,
    queuedDraftId,
  });
}

/** `sequence tick` — advance every active run by one step (queues drafts whose delay has
 *  elapsed; stops runs whose account has replied). Queue-only, never sends. */
async function runSequenceTick(ctx: CliContext): Promise<void> {
  const store = await openSequenceStore(ctx.memory);
  const result = await tickSequences({
    memory: ctx.memory,
    drafts: ctx.draftStore,
    store,
    executor: new DirectExecutor(),
  });
  printSequenceTickResult(result);
}

/** `sequence list` — every run with its status + current step (observability). */
async function runSequenceList(ctx: CliContext): Promise<void> {
  const store = await openSequenceStore(ctx.memory);
  const runs = await store.listRuns();
  printSequenceList(runs);
}

/** replied/meeting -> qualified (label 1); no_response -> not qualified (label 0); every other
 *  result (sent/published/returned) is non-terminal for training and yields no label. */
function terminalLabel(result: OutcomeResult): number | null {
  if (result === "replied" || result === "meeting") return 1;
  if (result === "no_response") return 0;
  return null;
}

/** Every persisted account paired with its own signals — the BALD candidate pool. */
async function loadAccountCandidates(ctx: CliContext): Promise<QualifierCandidate[]> {
  const rows = await ctx.memory.query<{ data: string }>("SELECT data FROM accounts");
  const candidates: QualifierCandidate[] = [];
  for (const row of rows) {
    const account = Account.parse(JSON.parse(String(row.data)));
    const signals = await ctx.memory.getSignalsForAccount(account.domain);
    candidates.push({ account, signals });
  }
  return candidates;
}

/**
 * `mstack train-qualifier` — the closed-loop demo. Joins each terminal return-leg Outcome back
 * to the account it came from and turns the engagement into a supervised label, then fits the
 * offline Gaussian-Process qualifier and surfaces the single most-uncertain account (BALD) as a
 * sample of what would route to human review.
 *
 * THE JOIN (documented mapping): Outcome(ref_type='draft') --ref_id--> Draft(kind='outreach_email',
 * whose refId is the account id) --> Account --> its signals. Any outcome whose draft is missing,
 * isn't an outreach draft, or has no account is SKIPPED and counted (the offline sample outcomes
 * reference fictional draft ids, so on sample-only data they all skip — that is expected, not a
 * bug; a real approved-then-replied draft joins cleanly). `fit` featurizes each (account, signals)
 * example internally via the package's `featurize`. An empty example set resets to the cold-start
 * prior (no crash) — every account then routes to review, which is correct cold-start behavior.
 */
export async function runTrainQualifier(ctx: CliContext): Promise<TrainQualifierSummary> {
  const outcomeRows = await ctx.memory.query<{ data: string }>(
    "SELECT data FROM outcomes WHERE ref_type = 'draft'",
  );

  const examples: LabeledExample[] = [];
  let skippedNonTerminal = 0; // sent / published / returned — not a training signal
  let skippedNoJoin = 0; // draft missing / not outreach / no account behind it

  for (const row of outcomeRows) {
    const outcome = Outcome.parse(JSON.parse(String(row.data)));
    const label = terminalLabel(outcome.result);
    if (label === null) {
      skippedNonTerminal++;
      continue;
    }
    const draft = await ctx.memory.getDraft(outcome.refId);
    if (!draft || draft.kind !== "outreach_email") {
      skippedNoJoin++;
      continue;
    }
    const account = await ctx.memory.getAccount(draft.refId);
    if (!account) {
      skippedNoJoin++;
      continue;
    }
    const signals = await ctx.memory.getSignalsForAccount(account.domain);
    examples.push({ account, signals, label });
  }

  const qualifier = new GaussianProcessQualifier();
  qualifier.fit(examples); // empty -> cold-start prior (no crash)

  const candidates = await loadAccountCandidates(ctx);
  const topReview = qualifier.selectForReview(candidates, 1)[0];

  return {
    trained: examples.length,
    skippedNonTerminal,
    skippedNoJoin,
    fitted: qualifier.fitted,
    sample: topReview
      ? {
          domain: topReview.account.domain,
          uncertaintyStd: topReview.posterior.std,
          informationGain: topReview.informationGain,
        }
      : undefined,
  };
}
