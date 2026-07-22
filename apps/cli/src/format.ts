/**
 * format.ts — console output for each subcommand. Presentation only; all the
 * work lives in seed.ts / demo.ts / commands.ts. Kept plain and calm (no panic
 * framing) per docs/build-conventions.md prompt-hygiene.
 */
import type { Draft, Outcome, ReviewResult } from "@mstack/core";
import type { ScoreResult } from "@mstack/core";
import { formatReport } from "@mstack/analytics";
import type { GtmReport } from "@mstack/analytics";
import type { IngestOutcomesResult } from "@mstack/adapters-outcomes";
import type { SequenceRun, TickResult } from "@mstack/sequences";

import type { Mode } from "./context.js";
import type { DemoResult } from "./demo.js";
import type { SeedResult } from "./seed.js";

const RULE = "─".repeat(72);

export function printModeBanner(mode: Mode): void {
  const detail =
    mode === "live"
      ? "ANTHROPIC_API_KEY set — Claude for extraction / judgment / copy"
      : "no ANTHROPIC_API_KEY — deterministic + rules + fixtures, zero network";
  console.log(`mstack — mode: ${mode.toUpperCase()} (${detail})`);
}

export function printSeedResult(seed: SeedResult): void {
  console.log(RULE);
  console.log("seed — loaded the offline fixtures into the warehouse + corpus:");
  console.log(`  signals persisted:        ${seed.signals}`);
  console.log(`  guidelines persisted:     ${seed.guidelines}`);
  console.log(`  enrichment fixtures:      ${seed.enrichmentFixtures} (resolved to Accounts at activation time)`);
  console.log(
    `  corpus passages embedded: ${seed.corpusPassages < 0 ? "skipped (LanceDB unavailable — offline demo does not need it)" : seed.corpusPassages}`,
  );
  console.log("Idempotent — safe to re-run. Next: mstack demo");
}

export function printDemoResult(demo: DemoResult): void {
  console.log(RULE);
  console.log("CONTENT-REVIEW  (asset → claim-drift review → partner-email + export drafts)");
  for (const r of demo.reviews) {
    const cats = Object.entries(r.findingsByCategory);
    const catStr = cats.length > 0 ? cats.map(([c, n]) => `${c}×${n}`).join(", ") : "none";
    const marker = r.verdict === "RETURNED" ? "RETURNED" : "APPROVED";
    console.log(`  • ${r.partnerId} — "${r.contentTitle}"`);
    console.log(`      verdict ${marker} · score ${r.score}/5 · ${r.totalFindings} finding(s) [${catStr}]`);
  }

  console.log("");
  console.log("ACCOUNT-ACTIVATION  (signals → score → decision → outreach draft)");
  for (const d of demo.decisions) {
    console.log(`  • ${d.domain} — score ${d.score}/100 · ${d.tier}`);
    console.log(`      next best action: ${d.nextBestAction} → ${d.targetMember} (email)`);
    console.log(`      relevant signals: ${d.relevantSignalIds.join(", ") || "(none)"}`);
  }

  console.log("");
  console.log(`DRAFTS AWAITING APPROVAL  (${demo.pendingDrafts.length} pending under ${demo.draftsDir}/)`);
  for (const draft of demo.pendingDrafts) {
    console.log(`  • ${draft.id}  ${draft.kind.padEnd(14)}  ${draft.subject ?? "(no subject)"}`);
  }

  console.log("");
  console.log(`OUTBOX: EMPTY (${demo.outboxCount} dispatched) — nothing was sent. A human approves every send.`);
  console.log(RULE);
  console.log("Approve one to close the loop:  mstack approve <draftId>   (then check outbox/)");
}

export function printApproveResult(draftId: string, outcome: Outcome, draft: Draft | null): void {
  console.log(RULE);
  console.log(`approve — dispatched draft ${draftId}`);
  console.log(`  outcome:   ${outcome.result} (${outcome.id})`);
  console.log(`  draft now: ${draft?.status ?? "unknown"}`);
  const outboxPath = outcome.metrics?.["outboxPath"];
  if (typeof outboxPath === "string") {
    console.log(`  written:   ${outboxPath}`);
  }
  console.log("The send is recorded in the hash-chained audit log (mstack verifies it on approve).");
}

export function printExportAuditResult(count: number, path: string): void {
  console.log(RULE);
  console.log(`export-audit — wrote ${count} halo-record(s) (schema v0.1) to ${path}`);
  console.log(`Verify independently with the external halo-record CLI:  halo verify ${path}`);
}

export function printPendingList(drafts: Draft[]): void {
  console.log(RULE);
  if (drafts.length === 0) {
    console.log("list — no drafts awaiting approval.");
    return;
  }
  console.log(`list — ${drafts.length} draft(s) awaiting approval:`);
  for (const draft of drafts) {
    console.log(`  • ${draft.id}  ${draft.kind.padEnd(14)}  ref=${draft.refId}`);
    console.log(`      ${draft.subject ?? "(no subject)"}`);
  }
}

export function printReviewResult(title: string, review: ReviewResult): void {
  console.log(RULE);
  console.log(`review — "${title}"`);
  console.log(`  verdict ${review.verdict} · score ${review.score}/5 · ${review.changesCount} required change(s)`);
  if (review.findings.length === 0) {
    console.log("  no findings — publish-ready.");
  } else {
    review.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.category}${f.required ? " · REQUIRED" : ""}] "${f.quote}"`);
      console.log(`     → ${f.recommendedChange}`);
    });
  }
  console.log(`  note: ${review.summary}`);
}

export function printScoreResult(domain: string, score: ScoreResult): void {
  console.log(RULE);
  console.log(`score — ${domain}`);
  console.log(`  ${score.score}/100 · ${score.tier}`);
  console.log(`  rationale: ${score.rationale ?? "(none provided)"}`);
}

export function printIngestOutcomesResult(result: IngestOutcomesResult): void {
  console.log(RULE);
  console.log("ingest-outcomes — pulled the offline sample return-leg into the warehouse:");
  console.log(
    `  ingested ${result.ingested} outcome(s)${result.pulled !== result.ingested ? ` (of ${result.pulled} pulled)` : ""}`,
  );
  if (result.skippedDuplicateIds.length > 0) {
    console.log(`  skipped ${result.skippedDuplicateIds.length} in-batch duplicate id(s)`);
  }
  console.log("The return leg is closed — next: mstack report  ·  mstack train-qualifier");
}

/** `report` prints the combined GTM report as-is: `formatReport` already emits the `─`-rule
 *  section dividers this module uses, so no extra framing is added here. */
export function printReport(report: GtmReport): void {
  console.log(formatReport(report));
}

export interface SequenceStartInfo {
  runId: string;
  sequenceName: string;
  accountRef: string;
  /** true if `<domain>` resolved to a persisted, scored Account (vs. enrolled by domain string). */
  resolvedFromAccount: boolean;
  status: string;
  /** the PENDING draft queued by step-0, if it was due (it is, for the bundled cadence). */
  queuedDraftId: string | undefined;
}

export function printSequenceStartResult(info: SequenceStartInfo): void {
  console.log(RULE);
  console.log(`sequence start — enrolled ${info.accountRef} into "${info.sequenceName}"`);
  console.log(`  run:     ${info.runId} (status ${info.status})`);
  console.log(
    `  target:  ${info.accountRef} ${info.resolvedFromAccount ? "(resolved to a scored account)" : "(no scored account yet — enrolled by domain)"}`,
  );
  if (info.queuedDraftId) {
    console.log(
      `  step-1:  queued as PENDING draft ${info.queuedDraftId} — awaiting approval, nothing sent`,
    );
    console.log(`Approve it to send:  mstack approve ${info.queuedDraftId}   (or: mstack list)`);
  } else {
    console.log("  step-1:  not yet due — no draft queued (advance later with: mstack sequence tick)");
  }
}

export function printSequenceTickResult(result: TickResult): void {
  console.log(RULE);
  if (result.runsExamined === 0) {
    console.log("sequence tick — no active runs to advance. (Start one: mstack sequence start <domain>)");
    return;
  }
  console.log(
    `sequence tick — examined ${result.runsExamined} active run(s), advanced ${result.advanced}:`,
  );
  for (const summary of result.summaries) {
    const detail =
      summary.outcome === "queued"
        ? `queued PENDING draft ${summary.queuedDraftId ?? "(unknown)"} (now at step ${summary.currentStep})`
        : summary.outcome === "stopped"
          ? "stopped (account replied)"
          : summary.outcome === "completed"
            ? "completed (last step reached)"
            : "no change (next step not due yet)";
    console.log(`  • ${summary.runId}  ${summary.accountRef.padEnd(20)}  ${detail}`);
  }
  console.log("Every queued draft is PENDING — a human approves each send.");
}

export function printSequenceList(runs: SequenceRun[]): void {
  console.log(RULE);
  if (runs.length === 0) {
    console.log("sequence list — no runs yet. (Start one: mstack sequence start <domain>)");
    return;
  }
  console.log(`sequence list — ${runs.length} run(s):`);
  for (const run of runs) {
    console.log(
      `  • ${run.id}  ${run.status.padEnd(9)}  step ${run.currentStep}  ${run.accountRef}  (${run.queuedDraftIds.length} draft(s) queued)`,
    );
  }
}

export interface TrainQualifierSummary {
  trained: number;
  skippedNonTerminal: number;
  skippedNoJoin: number;
  fitted: boolean;
  sample: { domain: string; uncertaintyStd: number; informationGain: number } | undefined;
}

export function printTrainQualifierResult(summary: TrainQualifierSummary): void {
  console.log(RULE);
  console.log("train-qualifier — offline active-learning lead qualifier (Gaussian Process + BALD):");
  console.log(
    `  trained on ${summary.trained} labeled example(s)${summary.fitted ? "" : " — cold-start prior (unfitted): every account routes to human review"}`,
  );
  const skipped = summary.skippedNonTerminal + summary.skippedNoJoin;
  if (skipped > 0) {
    console.log(
      `  skipped ${skipped} outcome(s): ${summary.skippedNonTerminal} non-terminal (sent/published/returned), ${summary.skippedNoJoin} with no matching outreach draft → account`,
    );
  }
  if (summary.sample) {
    console.log(`  most-uncertain account (sample → would route to review): ${summary.sample.domain}`);
    console.log(
      `      posterior std ${summary.sample.uncertaintyStd.toFixed(3)} · BALD info-gain ${summary.sample.informationGain.toFixed(3)}`,
    );
  } else {
    console.log("  (no accounts to rank yet — run mstack seed && mstack demo first)");
  }
  console.log("Approvals become labels: approve/reject drafts, then re-run to refit the qualifier.");
}

export function printHelp(): void {
  console.log(
    [
      "mstack — the offline demo driver for the Marketing Agents Stack",
      "",
      "Usage: mstack <command> [args] [--flags]",
      "",
      "Commands:",
      "  seed                 Load sample signals + accounts + north-star corpus into the warehouse",
      "  demo                 Run BOTH workflows end-to-end; land pending drafts; dispatch nothing",
      "  list                 List drafts awaiting approval",
      "  approve <draftId>    Approve + dispatch one draft (the only path to an outbox send)",
      "  review <file>        Review one asset file (.json ReviewRequest, or raw text)",
      "  score  <domain>      Score one account by domain (rules-only, offline)",
      "  ingest-outcomes      Pull the offline sample return-leg (replies/meetings) into the warehouse",
      "  report               Print the GTM funnel + conversion-by-tier + review outcomes",
      "  sequence <sub>       Cadence engine: start <domain> | tick | list (queues PENDING drafts, never sends)",
      "  train-qualifier      Fit the offline active-learning lead qualifier from recorded outcomes",
      "  export-audit         Export the approvals hash chain in halo-record's verifiable schema",
      "  help                 Show this help",
      "",
      "Flags:",
      "  --data-dir <dir>     Warehouse + corpus root      (env DATA_DIR,   default ./.data)",
      "  --drafts-dir <dir>   Pending-draft files          (env DRAFTS_DIR, default ./drafts)",
      "  --outbox-dir <dir>   Dispatched sends             (env OUTBOX_DIR, default ./outbox)",
      "  --format <fmt>       export-audit format          (only \"halo\" is implemented)",
      "  --out <file>         export-audit destination     (default: print JSON to stdout)",
      "",
      "Mode: live iff ANTHROPIC_API_KEY is set, else offline (no network, no credentials).",
      "",
      "Quickstart:  mstack seed && mstack demo",
      "Full loop:   mstack seed && mstack demo && mstack ingest-outcomes && mstack report",
    ].join("\n"),
  );
}
