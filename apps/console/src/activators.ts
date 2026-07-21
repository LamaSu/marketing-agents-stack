/**
 * activators.ts — the `activateFn` injected into `runAccountActivation` (@mstack/runtime).
 *
 * This MIRRORS `apps/cli/src/activators.ts` (docs/build-conventions.md: "REUSE this
 * pattern"). `@mstack/cli` only exposes its bin entry through its `exports` map, so the
 * builder can't be imported across apps — the console reproduces the same two builders so
 * the web UI and the CLI drive the account-activation workflow identically.
 *
 *   - offline: `resolveAccount` (context engine, no LLM) + `RulesScorer` → a TEMPLATED core
 *     `Decision` (relevantSignals = the account's REAL signalIds, committee from the
 *     enrichment record, a templated next-best-action) + a templated pending outreach
 *     `Draft`. No network, no LLM.
 *   - live: `@mstack/account-intel#activateAccount` (the SDR→Copywriter→Router swarm),
 *     ADAPTED — see `liveActivateFn` for the AccountDecision→Decision wrinkle.
 *
 * GUARDRAIL #6 ("never invent a signal"): offline `relevantSignals` cite only ids that
 * actually appear in the account's persisted `Signal[]`.
 * DRAFT-FIRST: the draft is always `pending`; nothing here dispatches.
 */
import { Decision, Draft, newId, nowIso } from "@mstack/core";
import type {
  CommitteeMember,
  NextBestAction,
  RelevantSignal,
  ScoreResult,
  Signal,
} from "@mstack/core";
import type { EnrichmentProvider, ScoringProvider } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";
import { activateAccount, resolveAccount } from "@mstack/account-intel";
import type { ActivateFn } from "@mstack/runtime";

const MAX_RELEVANT_SIGNALS = 6;

/** Most-recent-first, capped, real ids only — mirrors the SDR-Researcher surfacing the
 *  relevant subset (never inventing a signal). */
function pickRelevantSignals(signals: Signal[]): RelevantSignal[] {
  return [...signals]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, MAX_RELEVANT_SIGNALS)
    .map((s) => ({
      signalId: s.id,
      why: `${s.kind} signal${s.action ? ` "${s.action}"` : ""} on ${s.ts.slice(0, 10)} — real engagement evidence for this account (templated; offline, no LLM).`,
    }));
}

/** Prefer an executive sponsor / key technical influence; else the first member. */
function pickTargetMember(committee: CommitteeMember[]): string {
  const first = committee[0];
  if (!first) return "(no buying committee resolved)";
  const influential = committee.find((m) => /sponsor|executive|technical influence/i.test(m.influence ?? ""));
  return (influential ?? first).name;
}

function templatedNextBestAction(committee: CommitteeMember[], score: ScoreResult): NextBestAction {
  const action =
    score.tier === "STRONG_FIT"
      ? "Book a technical deep-dive and share the ROI brief"
      : score.tier === "FIT"
        ? "Send a personalized intro referencing the recent activity"
        : score.tier === "PARTIAL_FIT"
          ? "Nurture: share a relevant case study, no hard ask yet"
          : "Hold — below the ICP fit threshold; do not reach out";
  return { action, channel: "email", targetMember: pickTargetMember(committee) };
}

function templatedSubject(name: string, score: ScoreResult): string {
  return `${name} × KLZ — ${score.tier.replace(/_/g, " ").toLowerCase()} (${score.score}/100)`;
}

function templatedOutreachBody(
  name: string,
  committee: CommitteeMember[],
  relevantSignals: RelevantSignal[],
  score: ScoreResult,
): string {
  const target = pickTargetMember(committee);
  const signalLines =
    relevantSignals.length > 0
      ? relevantSignals.map((s) => `  - ${s.signalId}: ${s.why}`).join("\n")
      : "  (no signals on file yet)";
  return [
    `Hi ${target},`,
    "",
    `${name} keeps coming up in our account signals (fit score ${score.score}/100 — ${score.tier}). A few things we noticed:`,
    signalLines,
    "",
    `Templated draft only — no LLM generated this in offline mode. It sits in drafts/ awaiting human approval; nothing has been sent.`,
    "",
    "— KLZ GTM (automated draft; pending human approval)",
  ].join("\n");
}

/**
 * OFFLINE activateFn — resolve (context engine) + RulesScorer, then TEMPLATE the full
 * `Decision` + a pending outreach `Draft`. No swarm, no LLM. Persists the scored account
 * onto its row (compounding memory), mirroring `activateAccount`.
 */
export function offlineActivateFn(deps: {
  memory: MemoryRepo;
  enrichment: EnrichmentProvider;
  scoring: ScoringProvider;
}): ActivateFn {
  return async (input) => {
    const { account, signals, enrichment } = await resolveAccount(
      input.accountRef,
      { memory: deps.memory, enrichment: deps.enrichment },
      { since: input.window?.since },
    );

    const score = await deps.scoring.score(account, signals);
    const ts = nowIso();
    await deps.memory.putAccount({ ...account, score: score.score, tier: score.tier, lastScoredAt: ts });

    const committee: CommitteeMember[] = enrichment?.contacts ?? account.buyingCommittee;
    const relevantSignals = pickRelevantSignals(signals);
    const nextBestAction = templatedNextBestAction(committee, score);
    const rationale = score.rationale ?? `${score.tier} (${score.score}/100) via ${deps.scoring.name}.`;

    const decision = Decision.parse({
      id: newId("dec"),
      accountId: account.id,
      ts,
      score: score.score,
      tier: score.tier,
      relevantSignals,
      buyingCommittee: committee,
      nextBestAction,
      rationale,
      byAgent: `offline-${deps.scoring.name}`,
      mode: input.mode,
    });

    const draft = Draft.parse({
      id: newId("dr"),
      kind: "outreach_email",
      refId: account.id,
      subject: templatedSubject(account.name, score),
      body: templatedOutreachBody(account.name, committee, relevantSignals, score),
      channel: "email",
      status: "pending",
      createdBy: "offline-copywriter",
      createdAt: ts,
    });

    return { decision, draft };
  };
}

/**
 * LIVE activateFn — the account-intel swarm, adapted to the runtime's contract.
 *
 * WRINKLE (documented in workflows/account-activation.ts): `activateAccount` returns the
 * smaller `AccountDecision` BRIEF and self-persists its own full `Decision`/`Draft`/`Account`.
 * `runAccountActivation` wants the full `Decision` primitive, so we reconstruct it from the
 * brief — `accountId`/`ts` come from the returned draft (`refId` = account.id, `createdAt` =
 * the swarm timestamp). `runAccountActivation` then persists this reconstructed row; because
 * `activateAccount` already wrote one under its own id, a live run leaves TWO (equally valid)
 * decision rows for the activation — a known, harmless live-wiring artifact. The offline path
 * (the make-or-break demo) never touches this function.
 */
export function liveActivateFn(deps: { memory: MemoryRepo; enrichment: EnrichmentProvider }): ActivateFn {
  return async (input) => {
    const { decision: brief, draft } = await activateAccount(input, {
      memory: deps.memory,
      enrichment: deps.enrichment,
    });

    const decision = Decision.parse({
      id: newId("dec"),
      accountId: draft.refId,
      ts: draft.createdAt,
      score: brief.score,
      tier: brief.tier,
      relevantSignals: brief.relevantSignals,
      buyingCommittee: brief.buyingCommittee,
      nextBestAction: brief.nextBestAction,
      rationale: brief.rationale,
      byAgent: "account-intel-swarm",
      mode: input.mode,
    });

    return { decision, draft };
  };
}
