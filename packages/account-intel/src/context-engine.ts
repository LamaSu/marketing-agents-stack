/**
 * Context engine -- `resolveAccount()` (research/06-architecture.md §1.1's
 * "CONTEXT ENGINE (packages/account-intel)" box + §3.2).
 *
 * Gathers one account's persisted `Signal[]` -- optionally pulling fresh
 * ones from an injected `SignalSource` first, then always reading the
 * account's full history back from `MemoryRepo` -- plus one
 * `EnrichmentProvider.enrich()` call, and resolves them into a validated
 * `Account` with per-field provenance carried straight from the enrichment
 * record. This module does NOT re-decide trust between conflicting sources
 * -- that's `EnrichmentProvider` / `mergeEnrichment`'s job upstream
 * (guardrail #6, research/06-architecture.md §8); it only ever consumes ONE
 * already-resolved `EnrichmentRecord` and carries its `provenance` onto the
 * `Account` row unchanged.
 *
 * Idempotent per domain: if an `Account` row already exists for this domain,
 * its `id` is reused (looked up via `MemoryRepo`'s generic `query()` escape
 * hatch -- there is no `getAccountByDomain` in the given API) rather than
 * minting a new random id on every activation run, so repeated activation of
 * the same account compounds onto ONE row instead of forking a new one each
 * time (guardrail #3, "the data foundation is the moat" -- compounding only
 * works if the id is stable).
 *
 * Domain matching caveat: `MemoryRepo.getSignalsForAccount`'s underlying
 * query is an exact, case-sensitive `company = $company` match. This module
 * normalizes `ref.domain` to lowercase before both writing and reading
 * (matching the sample fixtures, which are already all-lowercase); a signal
 * persisted with different casing would not be found by the read-back. That
 * would need a `@mstack/memory` change to fix -- out of this package's scope.
 */
import { Account, newId } from "@mstack/core";
import type { EnrichmentProvider, EnrichmentRecord, Signal, SignalSource } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

export interface AccountRef {
  domain: string;
  name?: string;
}

export interface ResolveAccountDeps {
  memory: MemoryRepo;
  enrichment: EnrichmentProvider;
  /** optional: pull fresh signals (filtered to this account) before reading
   *  the account's full persisted history. Omit to read only whatever
   *  `memory` already has for this domain (e.g. a repeat activation after
   *  the initial ingest). */
  signalSource?: SignalSource;
}

export interface ResolveAccountOptions {
  /** ISO-8601 lower bound, forwarded to both the SignalSource pull and the memory read-back. */
  since?: string;
}

export interface ResolveAccountResult {
  account: Account;
  signals: Signal[];
  enrichment: EnrichmentRecord | null;
}

async function findExistingAccountId(memory: MemoryRepo, domain: string): Promise<string | undefined> {
  const rows = await memory.query<{ data: string }>(
    "SELECT data FROM accounts WHERE domain = $domain LIMIT 1",
    { domain },
  );
  const row = rows[0];
  if (!row) return undefined;
  const parsed = Account.safeParse(JSON.parse(row.data));
  return parsed.success ? parsed.data.id : undefined;
}

/**
 * Resolve one account ref into a persisted `Account` + its `Signal[]` +
 * whatever `EnrichmentRecord` the provider had (or `null`). Always writes
 * the resolved `Account` (and any freshly-pulled signals) to `memory` --
 * this is the "persist Account + signals to memory" half of the context
 * engine's job; scoring and the swarm are separate steps layered on top
 * (see `ranking.ts` / `activate-account.ts`).
 */
export async function resolveAccount(
  ref: AccountRef,
  deps: ResolveAccountDeps,
  opts: ResolveAccountOptions = {},
): Promise<ResolveAccountResult> {
  const domain = ref.domain.trim().toLowerCase();

  if (deps.signalSource) {
    const pulled = await deps.signalSource.pull({ since: opts.since });
    const forThisAccount = pulled.filter((s) => s.actor.company?.trim().toLowerCase() === domain);
    for (const signal of forThisAccount) {
      await deps.memory.putSignal(signal);
    }
  }
  const signals = await deps.memory.getSignalsForAccount(domain, { since: opts.since });

  // EnrichmentProvider implementations in this repo are documented to
  // degrade gracefully (return null) rather than throw on a miss/network
  // failure -- see e.g. adapters-enrichment's SampleProvider/registry
  // providers' own tests ("returns null gracefully ... never throws"). This
  // module relies on that contract rather than re-wrapping every provider
  // call in a try/catch.
  const enrichment = await deps.enrichment.enrich({ domain, name: ref.name });
  const existingId = await findExistingAccountId(deps.memory, domain);

  const account = Account.parse({
    id: existingId ?? newId("acc"),
    domain,
    name: enrichment?.name ?? ref.name ?? domain,
    firmographic: enrichment?.firmographic ?? { tech: [] },
    provenance: enrichment?.provenance ?? {},
    signalRefs: signals.map((s) => s.id),
    buyingCommittee: enrichment?.contacts ?? [],
    lastScoredAt: null,
  });

  await deps.memory.putAccount(account);

  return { account, signals, enrichment };
}
