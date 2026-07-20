/**
 * Scoring as the noise filter -- `rankAccounts()` (research/06-architecture.md
 * §1.1's "DECIDE" box: "score is a filter, not the answer" -- Guan pillar 1,
 * "machine learning becomes an engine that can help you remove ... the
 * noise", §3.2). Only the top-N accounts by score go on to the (more
 * expensive) swarm.
 *
 * Pure and synchronous-friendly by design: it takes plain `Account[]` + a
 * `Record<domain, Signal[]>` rather than reading `MemoryRepo` itself, so
 * it's trivial to unit-test with any `ScoringProvider` and doesn't force a
 * particular signal-loading strategy on its caller. `activateAccount`'s own
 * single-account scoring step calls the injected `ScoringProvider` directly
 * rather than routing through this function -- there's only ever one
 * account in that path.
 */
import { Account, nowIso } from "@mstack/core";
import type { ScoringProvider, Signal } from "@mstack/core";
import { HybridScorer } from "@mstack/adapters-scoring";

export type SignalsByAccount = Record<string, Signal[]>;

/**
 * Score every account (signals looked up by `account.domain` in
 * `signalsByAccount`; a missing entry scores with an empty signal list,
 * never an error), attach `score`/`tier`/`lastScoredAt`, sort descending by
 * score, and return only the top `topN`. `scoring` defaults to
 * `HybridScorer` (research/06-architecture.md §3.2); inject `RulesScorer`
 * (or any `ScoringProvider`) for a fully offline, deterministic rank.
 */
export async function rankAccounts(
  accounts: Account[],
  signalsByAccount: SignalsByAccount,
  topN: number,
  scoring: ScoringProvider = new HybridScorer(),
): Promise<Account[]> {
  const scored = await Promise.all(
    accounts.map(async (account) => {
      const signals = signalsByAccount[account.domain] ?? [];
      const result = await scoring.score(account, signals);
      return Account.parse({
        ...account,
        score: result.score,
        tier: result.tier,
        lastScoredAt: nowIso(),
      });
    }),
  );
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, Math.max(0, topN));
}
