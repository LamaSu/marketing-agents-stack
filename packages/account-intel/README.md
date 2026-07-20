# @mstack/account-intel

Account-Intelligence engine + agent swarm (Guan's SignalSphere / "AI-native
decision system") — research/06-architecture.md §3.2, §7 W3-T3. The context
engine (`resolveAccount`) unifies an account's persisted signals + enrichment
into a core `Account` with per-field provenance; the scoring noise filter
(`rankAccounts`) ranks a pool of accounts and keeps only the top-N; the swarm
(SDR-Researcher → Copywriter → GTM-Router, three tight-scoped `runAgent`
calls) turns one top-N account into a decision brief + a pending outreach
draft. `activateAccount` is the single orchestrating entry point that runs
the whole pipeline for one account and persists the result to
`@mstack/memory`.

## What's here

- **`context-engine.ts`** — `resolveAccount(ref, deps)`. Gathers signals
  (optionally pulling fresh ones from an injected `SignalSource`, always
  reading the account's full persisted history back from `MemoryRepo`) + one
  `EnrichmentProvider.enrich()` call, and resolves them into a validated
  `Account` (per-field `provenance` carried straight from the enrichment
  record — this module does not re-decide trust; that's
  `EnrichmentProvider`/`mergeEnrichment`'s job upstream, per guardrail #6).
  Idempotent per domain: a second resolve reuses the same `Account.id`
  (looked up via `MemoryRepo`'s generic `query()` escape hatch — there's no
  `getAccountByDomain` in the given API) instead of forking a new row every
  run.
- **`ranking.ts`** — `rankAccounts(accounts, signalsByAccount, topN, scoring?)`.
  The noise filter (Guan pillar 1): scores every account, attaches
  `score`/`tier`, sorts descending, returns only the top N. Defaults to
  `HybridScorer`; inject `RulesScorer` (or any `ScoringProvider`) to stay
  fully offline.
- **`sdr-researcher.ts` / `copywriter.ts` / `gtm-router.ts`** — the three
  swarm workers, each one `runAgent` call with its own input type + Zod
  `outSchema`. See the table below.
- **`policy.ts`** — `isAutopilotEligible(tier, mode)`, a pure helper
  encoding the autopilot policy rule. This package **never** dispatches or
  auto-approves anything itself — see the guardrail note in
  `activate-account.ts`.
- **`activate-account.ts`** — `activateAccount(input, deps)`, the
  orchestrator: resolve → score → SDR-Researcher → Copywriter → GTM-Router →
  assemble + persist a full `Decision` → build + persist a pending `Draft`.
  Returns `{ decision: AccountDecision, draft: Draft }`.

## The swarm

| Worker | Model | Input | Output |
|---|---|---|---|
| **SDR-Researcher** | `modelFor("reasoner")` (sonnet) | account's `Signal[]` + the enrichment record | `{ relevantSignals: RelevantSignal[], buyingCommittee: CommitteeMember[] }` |
| **Copywriter** | `modelFor("copywriter")` (sonnet) | committee + relevantSignals + a brand-voice note | `{ subject, body }` (wrapped into a `Draft` by `activateAccount`, not by the model) |
| **GTM-Router** | `modelFor("router")` (haiku) | committee + score/tier + relevantSignals | `NextBestAction` (reused directly from `@mstack/core`) |

Each worker's system prompt is job-as-function (no identity inflation, no
panic framing — `docs/build-conventions.md` "Prompt hygiene for product
agents"); each worker's `*.test.ts` asserts this mechanically via
`checkPromptHygiene` from `@mstack/agents`, not just by eyeballing the prose.

**SDR-Researcher's grounding constraint is the load-bearing one**: its
system prompt requires every `relevantSignals[].signalId` to be one that
actually appears in the input `signals` array — "never invent a signal" —
the direct fix for "my AI is lying to me because it didn't have the
context" (Guan, research/06-architecture.md §3.2). `activate-account.test.ts`
proves this end-to-end: it derives the SDR-Researcher's canned response FROM
the real request's input signal ids (rather than a hand-picked fixture), so
the assertion that the swarm only ever cites real ids is testing the actual
plumbing, not a coincidence of matching fixtures.

## Worker output vs. the persisted primitives (why there are two "Decision" shapes)

`@mstack/core` defines both `Decision` (the persisted memory primitive —
`accountId`, `id`, `ts`, `byAgent`, `mode`) and `AccountDecision` (the
agent-facing decision brief — nested `account: {domain, name}`, no
persistence fields). `activateAccount` builds and persists a full `Decision`
row (`MemoryRepo.putDecision`) and returns the `AccountDecision` shape to the
caller — mirroring the same split `@mstack/core` already draws between
`FindingDraft`/`Finding` in the reviewer package. Likewise, the Copywriter
worker's own `outSchema` is a narrow `{subject, body}` — never a full
`Draft` — because the model must never mint a persistence id, set a draft's
`refId`, or touch its `status`; `activateAccount` is what assembles the
id-bearing, `status:'pending'` `Draft` from the worker's content.

## Draft-first, mechanically (not just by convention)

Nothing in this package ever calls `MemoryRepo.appendApproval`, and nothing
here ever constructs a `Draft` with any `status` other than the schema's own
`'pending'` default. `mode:'autopilot'` is carried through onto the
persisted `Decision.mode` field for Wave-4 `runtime` to read;
`policy.ts#isAutopilotEligible` is a pure eligibility rule for that runtime
to consult (never `STRONG_FIT`/VIP, per guardrail #2) — it is not itself a
dispatch path, and calling it changes nothing about what `activateAccount`
does. `activate-account.test.ts` asserts this directly: after activating an
account in `autopilot` mode, the resulting draft is still `status:'pending'`
and the `approvals` table is still empty.

## Tests are fully offline

Every test uses an injected fake `AnthropicClient` (built structurally
against the `AnthropicClient` type re-exported from `@mstack/agents` — this
package does not depend on `@anthropic-ai/sdk` directly; see the
`Awaited<ReturnType<...>>` trick in the test files) plus an in-memory
`MemoryRepo` (`openMemory(":memory:")`) and, for the context-engine and
integration tests, the **real** `data/signals.sample.jsonl` /
`data/accounts.sample.json` fixtures via the real `SampleSource` /
`SampleProvider` — not hand-rolled test doubles for those two. Scoring in
tests uses `RulesScorer` (deterministic, zero-dependency) rather than the
default `HybridScorer`, so no test needs to also script a scoring-path
Claude call.

```bash
pnpm --filter @mstack/account-intel test        # vitest run -- offline, no network
pnpm --filter @mstack/account-intel typecheck    # tsc --noEmit
```

Per `docs/build-conventions.md`, these were not run locally while writing
this package (the dev tablet OOMs on installs) — they run on Spark as part
of the wave's consolidated `pnpm install && pnpm -r build && pnpm -r test`.

## Known assumptions / simplifications (flagging honestly, per harness policy)

- **Case-sensitive domain matching in `MemoryRepo.getSignalsForAccount`**:
  the underlying query is an exact `WHERE company = $company` match (no
  `LOWER()` normalization in `@mstack/memory`, which this package does not
  modify). `resolveAccount` normalizes `ref.domain` to lowercase before both
  writing and reading, which matches the sample fixtures (already
  all-lowercase) — but a signal persisted with different casing than the
  normalized ref would not be found. Fixing this would mean changing
  `@mstack/memory`, out of this package's scope.
- **"Low-tier" for autopilot eligibility is `PARTIAL_FIT` only**
  (`policy.ts`) — a conservative reading of guardrail #2's "never
  STRONG_FIT/VIP"; `FIT` is excluded too by this package's default. The
  architecture doc's Appendix explicitly scopes the exact policy table to
  `runtime` as deployer config, so this is a default, not the final word.
- **`rankAccounts`'s per-account signal lookup is a `Record<domain,
  Signal[]>` the caller assembles**, not a `MemoryRepo` read — keeping the
  ranking function pure/synchronous-friendly and easy to unit test;
  `activateAccount`'s own single-account scoring step calls the injected
  `ScoringProvider` directly rather than going through `rankAccounts` (there
  is only ever one account in that path).
- **Swarm workers receive their evidence via `input` (JSON), not a
  `contextPack`.** `@mstack/agents`' `runAgent` supports labeled
  `contextPack` evidence blocks, and a future iteration could promote the
  signals/enrichment block into one without changing any output contract —
  the task's I/O contracts are stated as `input = ...`, so that's what's
  implemented.
- **`SignalSource.pull()` has no per-domain filter at the seam level**
  (`core/seams.ts`'s `pull(opts?: PullOptions)` takes only `since`/`limit`)
  — `resolveAccount` pulls and filters client-side by `actor.company`. Fine
  at this repo's sample scale; a high-volume real signal source would
  ideally filter server-side, which is a future adapter-level concern, not
  something this package's seam usage can change.
- **`activateAccount` lets `AgentOutputError` (from `runAgent`) and any
  `ScoringProvider`/`EnrichmentProvider` failure propagate** rather than
  swallowing it — the given implementations of those seams are documented to
  degrade gracefully on their own (never throw for a missing optional
  contributor / a miss / a network failure), so no extra try/catch is added
  on top; a genuine worker output failure after `runAgent`'s one bounded
  re-ask is a real error the caller should see, not something to hide.
