/**
 * format.ts — console output for each subcommand. Presentation only; all the
 * work lives in seed.ts / demo.ts / commands.ts. Kept plain and calm (no panic
 * framing) per docs/build-conventions.md prompt-hygiene.
 */
import type { Draft, Outcome, ReviewResult } from "@mstack/core";
import type { ScoreResult } from "@mstack/core";

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
      "  help                 Show this help",
      "",
      "Flags:",
      "  --data-dir <dir>     Warehouse + corpus root      (env DATA_DIR,   default ./.data)",
      "  --drafts-dir <dir>   Pending-draft files          (env DRAFTS_DIR, default ./drafts)",
      "  --outbox-dir <dir>   Dispatched sends             (env OUTBOX_DIR, default ./outbox)",
      "",
      "Mode: live iff ANTHROPIC_API_KEY is set, else offline (no network, no credentials).",
      "",
      "Quickstart:  mstack seed && mstack demo",
    ].join("\n"),
  );
}
