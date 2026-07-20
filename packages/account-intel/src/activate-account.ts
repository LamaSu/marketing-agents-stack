/**
 * activateAccount -- the account-intel orchestrator (research/06-architecture.md
 * §3.2, and the non-HITL/non-dispatch half of the §4.2 `account-activation`
 * workflow steps 2-6; HITL approval + dispatch are Wave-4 `runtime` scope,
 * not this package's).
 *
 * Pipeline: resolve (context engine) -> score (noise filter, single-account
 * form) -> swarm (SDR-Researcher -> Copywriter -> GTM-Router, strictly
 * sequential) -> assemble an `AccountDecision` + a pending outreach `Draft`
 * -> persist the full `Decision` + `Draft` to memory.
 *
 * DRAFT-FIRST, MECHANICALLY: this function never calls
 * `MemoryRepo.appendApproval` and never sets a `Draft`'s status to anything
 * but the schema's own `'pending'` default -- there is no code path in this
 * package that dispatches. `mode:'autopilot'` is carried through onto the
 * persisted `Decision.mode` field (for Wave-4 `runtime` to read) and is
 * otherwise inert here; see `policy.ts#isAutopilotEligible` for the
 * eligibility rule Wave-4 would apply before ever auto-approving anything --
 * note it is never honored for STRONG_FIT/VIP accounts either way.
 */
import { ActivateAccount, AccountDecision, Decision, Draft, newId, nowIso } from "@mstack/core";
import type { EnrichmentProvider, ScoringProvider, SignalSource } from "@mstack/core";
import type { AnthropicClient } from "@mstack/agents";
import type { MemoryRepo } from "@mstack/memory";
import { HybridScorer } from "@mstack/adapters-scoring";

import { resolveAccount } from "./context-engine.js";
import { runSdrResearcher } from "./sdr-researcher.js";
import { runCopywriter, DEFAULT_BRAND_VOICE } from "./copywriter.js";
import { runGtmRouter } from "./gtm-router.js";

export interface ActivateAccountDeps {
  memory: MemoryRepo;
  enrichment: EnrichmentProvider;
  /** default: `HybridScorer` (research/06-architecture.md §3.2). Inject
   *  `RulesScorer` (or any `ScoringProvider`) to stay fully offline. */
  scoring?: ScoringProvider;
  /** optional: pull fresh signals before resolving (see `resolveAccount`). */
  signalSource?: SignalSource;
  /** injected fake client for offline tests; omitted -> each `runAgent` call
   *  builds a real Anthropic client from `ANTHROPIC_API_KEY`. */
  client?: AnthropicClient;
  brandVoice?: string;
  /** injectable clock; tests only. */
  now?: () => string;
}

export interface ActivateAccountResult {
  decision: AccountDecision;
  draft: Draft;
}

const BY_AGENT = "account-intel-swarm";

export async function activateAccount(
  input: ActivateAccount,
  deps: ActivateAccountDeps,
): Promise<ActivateAccountResult> {
  const parsed = ActivateAccount.parse(input);
  const scoring = deps.scoring ?? new HybridScorer();
  const now = deps.now ?? nowIso;

  // 1. resolve -- context engine.
  const { account, signals, enrichment } = await resolveAccount(
    parsed.accountRef,
    { memory: deps.memory, enrichment: deps.enrichment, signalSource: deps.signalSource },
    { since: parsed.window?.since },
  );

  // 2. score -- noise filter (single-account form; `rankAccounts` is the
  // multi-account version of this same step, used upstream to pick which
  // accounts even reach `activateAccount`).
  const scoreResult = await scoring.score(account, signals);
  await deps.memory.putAccount({
    ...account,
    score: scoreResult.score,
    tier: scoreResult.tier,
    lastScoredAt: now(),
  });

  // 3. swarm -- SDR-Researcher -> Copywriter -> GTM-Router, strictly
  // sequential: each downstream worker's input is built from the prior
  // worker's output.
  const sdrOut = await runSdrResearcher(
    { account: { domain: account.domain, name: account.name }, signals, enrichment },
    deps.client,
  );
  const copy = await runCopywriter(
    {
      account: { domain: account.domain, name: account.name },
      committee: sdrOut.buyingCommittee,
      relevantSignals: sdrOut.relevantSignals,
      brandVoice: deps.brandVoice ?? DEFAULT_BRAND_VOICE,
    },
    deps.client,
  );
  const nextBestAction = await runGtmRouter(
    {
      committee: sdrOut.buyingCommittee,
      score: scoreResult.score,
      tier: scoreResult.tier,
      relevantSignals: sdrOut.relevantSignals,
    },
    deps.client,
  );

  const rationale = scoreResult.rationale ?? `${scoreResult.tier} (${scoreResult.score}/100) via ${scoring.name}.`;
  const ts = now();

  // 4. assemble + persist the full Decision (the memory primitive -- see the
  // file header + README for why this is distinct from the AccountDecision
  // brief returned below).
  const decision = Decision.parse({
    id: newId("dec"),
    accountId: account.id,
    ts,
    score: scoreResult.score,
    tier: scoreResult.tier,
    relevantSignals: sdrOut.relevantSignals,
    buyingCommittee: sdrOut.buyingCommittee,
    nextBestAction,
    rationale,
    byAgent: BY_AGENT,
    mode: parsed.mode,
  });
  await deps.memory.putDecision(decision);

  // 5. draft-first action -- ALWAYS 'pending' (the schema's own default);
  // this package never sets any other status and never appends an Approval.
  const draft = Draft.parse({
    id: newId("dr"),
    kind: "outreach_email",
    refId: account.id,
    subject: copy.subject,
    body: copy.body,
    channel: "email",
    createdBy: "copywriter",
    createdAt: ts,
  });
  await deps.memory.putDraft(draft);

  const accountDecision = AccountDecision.parse({
    account: { domain: account.domain, name: account.name },
    score: scoreResult.score,
    tier: scoreResult.tier,
    relevantSignals: sdrOut.relevantSignals,
    buyingCommittee: sdrOut.buyingCommittee,
    nextBestAction,
    rationale,
  });

  return { decision: accountDecision, draft };
}
