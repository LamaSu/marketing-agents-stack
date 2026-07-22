# @mstack/analytics

Deterministic, offline funnel + conversion reporting over the `@mstack/memory`
warehouse — the funnel/dashboard layer every incumbent (MadKudu, Outreach,
Clearbit) ships as its core reporting surface, built here as a thin,
read-only aggregation over the existing `MemoryRepo` (no new data model, no
new writes). Every function in this package only ever calls
`memory.query()` — no network, no LLM call, no mutation of the warehouse.

## What's here

- **`funnelReport(memory, opts?)`** — the GTM funnel, 8 stages + stage-to-stage
  conversion rates:

  ```
  signals ingested → accounts scored → decisions made → drafts created
  → drafts approved → dispatched (sent) → replied → meeting
  ```

  One aggregate SQL round trip (8 scalar subqueries); every stage's count
  comes straight from `COUNT(*)`/`COUNT(DISTINCT ...)`, never a JS loop over
  rows. See the big comment above `FUNNEL_SQL` in `src/report.ts` for the
  exact table/column each stage reads and why.

- **`conversionByTier(memory, opts?)`** — per-`AccountTier` (STRONG_FIT / FIT /
  PARTIAL_FIT / DISQUALIFIED) sent/replied/meeting rates over that tier's
  outreach drafts. Always returns all 4 tiers (zero-filled if a tier has no
  accounts/drafts yet) so the shape is stable for a dashboard regardless of
  what data exists.

- **`reviewOutcomes(memory, opts?)`** — APPROVED vs RETURNED counts +
  approval rate from `reviews.verdict`, plus the top claim-drift categories
  (ranked by count, default top 5) from the denormalized `findings` table.

- **`buildGtmReport(memory, opts?)`** — convenience: runs all three above in
  parallel and bundles them into one `GtmReport`.

- **`formatReport(report)`** — renders a `GtmReport` as a readable,
  dependency-free text table (plus `formatFunnelReport` /
  `formatConversionByTier` / `formatReviewOutcomes` for one section at a
  time). Matches `apps/cli/src/format.ts`'s existing `─`-rule convention, so
  a future `mstack report` command can call
  `console.log(formatReport(await buildGtmReport(memory)))` unchanged. This
  package does not modify `apps/*` — it only provides the API + formatter
  that command would call.

## Why `draftsCreated` can exceed `decisionsMade` (not a bug)

This repo has **two independent draft-producing workflows** that both write
into the same `drafts` table: content-review (`partner_email`/
`review_export` drafts, keyed off a `Review`) and account-activation
(`outreach_email` drafts, keyed off a `Decision`). `draftsCreated` counts
drafts from both; `decisionsMade` only counts the account-activation half.
So a conversion rate > 100% between those two stages is a real property of
the two-workflow system, not a funnel-math defect — flagged in `report.ts`'s
file header so a future reader isn't confused by it.

## How `conversionByTier` joins drafts to accounts without a `kind` column

`drafts` has no `kind` column (`id/ref_id/status/created_at/data` only —
`kind` lives inside the JSON `data` blob). The join doesn't need one:
`outreach_email` drafts carry `refId = account.id` ("acc_...",
`activate-account.ts`) while `partner_email`/`review_export` drafts carry
`refId = reviewId` ("rev_...", `review-agent.ts`) — different `newId()`
prefixes, so a content-review draft's `ref_id` can never match an
`accounts.id` row. `d.ref_id = a.id` is therefore already an exact join,
with no need to parse the JSON blob (and this package, like
`@mstack/memory` itself, deliberately avoids depending on DuckDB's JSON
extension).

## Tests are fully offline

Every test uses `openMemory(":memory:")` (same pattern as
`packages/memory/src/memory-repo.test.ts`) and hand-built fixtures via each
primitive's own Zod schema — no fixtures files, no network, no LLM call.

```bash
pnpm --filter @mstack/analytics test        # vitest run — offline, no network
pnpm --filter @mstack/analytics typecheck   # tsc --noEmit
```

Per `docs/build-conventions.md`, these were not run locally while writing
this package (the dev tablet OOMs on installs) — they run on Spark as part
of the wave's consolidated `pnpm install && pnpm -r build && pnpm -r test`.

## Known assumptions / simplifications (flagging honestly, per harness policy)

- **"Dispatched (sent)" reads `outcomes.result = 'sent'`, not
  `drafts.status = 'dispatched'`.** Both are set together by
  `runtime/src/dispatch.ts`, but that module's own file header is explicit
  that the `Outcome` row — not the channel, not the draft's status column —
  is "what memory learns 'sent' from," so this package treats it as the
  more authoritative source. In today's codebase the two are always in sync
  (there is exactly one dispatch path, `dispatchDraft`), so this only
  matters if that invariant ever changes.
- **`replied` / `meeting` funnel stages read 0 today, correctly.**
  `OutcomeResult` supports `replied`/`meeting`/`published`/`no_response`,
  but no producer in this repo writes them yet (only `dispatch.ts` writes
  `result:'sent'`). The funnel and per-tier reports are written to tolerate
  this — zero counts, zero conversion rates — rather than assume a producer
  exists; wiring a real reply/meeting-booked webhook is future `runtime`
  scope, not this package's.
- **`accountsScored` = `accounts.tier IS NOT NULL`.** Since `putAccount`
  upserts by id (one row per account, always reflecting the latest put),
  this correctly reflects "has this account been through the scoring step
  at least once" without needing a separate scored/unscored flag.
- **Zero-fill via `AccountTier.options` / `ReviewVerdict.options`, not a SQL
  `VALUES(...)`-list CTE.** This package (like its siblings) was written
  without a local `pnpm install`/test run per `docs/build-conventions.md`,
  so unverified DuckDB grammar (CTEs-as-lookup-tables, window functions) was
  avoided in favor of bog-standard `SELECT`/`JOIN`/`CASE WHEN`/
  `COUNT DISTINCT`/`GROUP BY`, with the zero-fill done in JS from the known
  Zod enum values instead.
- **`reviewOutcomes`'s claim-drift category read-back is defensively
  re-validated** (`ClaimCategory.safeParse`, dropping anything that fails)
  even though `Finding.category` is always a valid, non-nullable
  `ClaimCategory` at write time (`Review.parse` validates the whole nested
  array) — this only guards against a hypothetically corrupted row, so the
  report degrades instead of crashing, matching this package's "never crash
  on unexpected warehouse contents" contract.
