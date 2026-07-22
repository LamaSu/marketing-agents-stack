/**
 * crm-sync.ts — a package-local `CrmSync` seam: push OUR derived scores,
 * decisions, and outcomes back INTO a CRM (Salesforce/HubSpot/…). This is the
 * write-BACK half of the loop paid tools like MadKudu/ZoomInfo charge for:
 * enrichment + scoring is only half the value — writing the score onto the
 * Account/Lead record in the CRM the sales team already lives in is the
 * actual delivery mechanism. Closing that gap is this package's whole job.
 *
 * WHY A PACKAGE-LOCAL SEAM, NOT AN ADDITION TO `@mstack/core`'s `seams.ts`:
 * `CrmSync` is a write-back/export concern (push OUR data OUT to a
 * third-party system of record), distinct from the four core adapter seams
 * that bring data IN (`SignalSource` / `EnrichmentProvider` / `ScoringProvider`
 * / `GuidelineCorpus`) and from the one gated outbound seam (`OutreachChannel`,
 * which sends CONTENT to a human customer and therefore needs the Approval
 * gate — see below). Defining it here mirrors `adapters-enrichment/src/
 * llm-web.ts`'s `FetchSite` and `adapters-outreach/src/composio-channel.ts`'s
 * `ComposioLike`: a package is free to define and offline-test its own narrow
 * seam without widening the shared core contract every adapter package reads.
 *
 * WHY NO APPROVAL GATE (unlike `OutreachChannel`): guardrail #2 in
 * `docs/build-conventions.md` ("a human approves every send") governs sending
 * CONTENT to a human recipient via a `Draft`. `CrmSync` pushes DERIVED,
 * already-computed signal — a `score`/`tier` number, a `Decision` record, an
 * `Outcome` result — onto OUR OWN account's CRM record. No new customer-facing
 * content is created or sent; this is the same class of operation as
 * `@mstack/memory` writes (guardrail #3, compounding memory), aimed at a
 * third-party's datastore instead of ours. If a future write path pushes a
 * CRM-triggered customer send (e.g. a HubSpot workflow that emails a rep on
 * score change), THAT path must go back through `OutreachChannel` + `Approval`
 * — never through this seam.
 *
 * OFFLINE DEFAULT: `noopCrmSync` (below) is what every offline/keyless path,
 * including `mstack demo`, uses. It does nothing and never touches the
 * network — a deployer opts into a real sync explicitly. See
 * `http-crm-sync.ts` / `composio-crm-sync.ts` for the opt-in implementations,
 * both of which degrade to a logged warning + silent no-op on ANY failure —
 * mirroring `adapters-enrichment/src/crawl4ai.ts`'s "degraded, never broken"
 * contract — so a CRM outage can never break the scoring/decision loop that
 * produced the data in the first place.
 */
import type { Account, Decision, Outcome } from "@mstack/core";

/**
 * CrmSync — push OUR computed scores/decisions/outcomes back into an
 * external CRM. One-way (write-only): this seam never reads FROM the CRM
 * (pulling company data is `EnrichmentProvider`'s job, the opposite
 * direction). Every method returns `Promise<void>` and implementations MUST
 * NEVER THROW — a CRM-push failure degrades to a logged warning, exactly like
 * `crawl4aiFetchSite`'s failure contract, so a CRM being down or misconfigured
 * never breaks the caller's (offline-capable) loop.
 */
export interface CrmSync {
  readonly name: string;
  /** Push an account's current `score` / `tier` / `lastScoredAt` onto its CRM record. */
  pushScore(account: Account): Promise<void>;
  /** Push a full account-intel `Decision` (score, tier, rationale, next-best-action, …). */
  pushDecision(decision: Decision): Promise<void>;
  /** Push a closed-loop `Outcome` (sent/replied/meeting/…) for CRM activity history. */
  pushOutcome(outcome: Outcome): Promise<void>;
}

/**
 * noopCrmSync — the OFFLINE DEFAULT. Every method resolves immediately and
 * does nothing at all: no network call, no console output, no side effect of
 * any kind. This is what `mstack demo` and every keyless path uses; a
 * deployer must explicitly construct `createHttpCrmSync(...)` or
 * `createComposioCrmSync(...)` to push anything to a real CRM.
 */
export const noopCrmSync: CrmSync = {
  name: "noop",
  async pushScore(_account: Account): Promise<void> {
    // intentional no-op — offline default, nothing to degrade from
  },
  async pushDecision(_decision: Decision): Promise<void> {
    // intentional no-op — offline default, nothing to degrade from
  },
  async pushOutcome(_outcome: Outcome): Promise<void> {
    // intentional no-op — offline default, nothing to degrade from
  },
};
