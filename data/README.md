# data/ — the offline sample dataset

Everything under this directory is **fictional/synthetic sample data**, in the same spirit
as `research/04-slides-and-demos.md`'s stand-ins (KLZ = a vendor stand-in, ABC Corp /
Northland Analytics / Victorly / BrightPath = partner stand-ins). Company domains like
`figma.com` or `stripe.com` are used only as illustrative ICP-target labels — exactly how
the source demo itself uses "Figma" — and every contact, quote, and statistic attached to
them here is invented for this fixture set, not real data about those companies or people.

This is what makes `pnpm mstack seed && pnpm mstack demo` run end-to-end with **zero
credentials and zero network calls** (research/06-architecture.md §5.2).

## Files

| File | Shape | Rows |
|---|---|---|
| `signals.sample.jsonl` | one `Signal` (packages/core `schemas.ts`) per line | 85 |
| `accounts.sample.json` | JSON array of `EnrichmentRecord` (packages/core `seams.ts`) | 30 |
| `corpus/guidelines.json` | JSON array of `Guideline` (packages/core `schemas.ts`) | 21 |
| `corpus/approved-messaging.md` | prose — the RAG-ingest source | — |
| `corpus/assets/assets.json` | JSON array of `ReviewRequest` (packages/core `schemas.ts`) | 4 |

### `signals.sample.jsonl`

85 normalized events spanning all four signal kinds the account-activation demo uses —
`product_usage` (source `posthog`), `crm` (source `sql-warehouse`), `campaign` (source
`segment`), `intent` (source `github` / generic `intent-data`) — across 10 companies:
the four named in the SignalSphere demo (figma.com, airtable.com, stripe.com,
vercel.com) plus 6 fictional SMBs (meridianstack.io, fernwaylabs.com, basecrest.io,
tallgrass-data.com, orbitpoint.dev, cinderworks.co). Actions cover the concrete examples
from the transcript/demo: GitHub stars, docs views, whitepaper downloads, pricing-page
visits, direct-mail invite codes, demo requests, plus product-usage and CRM events
(feature use, seat invites, opportunity stage changes, renewals). Rows are sorted by
`ts` ascending and ids (`sig_0001`…) are assigned in that order, like an append-only
ingest log. Every actor identity used across a company's signals is drawn from a
no-replacement name pool, so no synthetic person appears "employed" at two different
companies.

### `accounts.sample.json`

30 `EnrichmentRecord`-shaped fixtures (`domain, name, firmographic{employees,industry,
region,tech[]}, contacts[], provenance{field→source}, source:"sample"`): the 10 companies
referenced by `signals.sample.jsonl` (richer — 3 contacts each) plus 20 additional
companies across varied industries/regions with no signal history yet, so the ICP-scoring
demo panel has a realistic-sized ranked pool to work over, not just the companies that
already have a signal trail. `figma.com`'s `contacts` are pinned to the exact SignalSphere
demo committee — **Aris Thorne** (SVP Engineering, Executive Sponsor) and **Linus
Sterling** (Principal Designer & System Architect, Key Technical Influence) — plus a third
Security-persona contact (Priya Nakamura) to exercise the demo's Engineering/Product/
Security persona heatmap. Every `contacts[].persona` uses the real `Persona` enum.

### `corpus/guidelines.json`

The reviewer's machine-checkable north star: 21 `Guideline` rows covering all five
`GuidelineType` values and all seven `ClaimCategory` values —

- **`lexicon`** (5 rows) — guarantee-word rules (`guarantee`/`guaranteed`/`ensures`/
  `promise`) and banned-superlative rules (`no other platform comes close`,
  `best-in-class`, `unmatched`, …), plus the uncited-quantitative-claim rule.
- **`denylist`** (4 rows) — roadmap/unannounced-codename rules (`Agent Marketplace`,
  internal codenames, any unannounced forward-looking date), plus a `pii_leak` rule
  (email addresses, SSNs, phone numbers, payment-card numbers — added Wave B2;
  see `packages/reviewer/src/rules.ts`'s `scanPii`/`presidioScan`).
- **`allowlist`** (3 rows) — the two approved KLZ spokespeople (Dana Whitfield, Sam
  Okafor) plus their two approved, verbatim-usable quotes.
- **`tier_map`** (2 rows) — the badge rule the demo calls out explicitly: "Powered by
  KLZ Orchestrate" is Elite-only; Select partners use "KLZ Select Partner"; Registered
  partners get no badge at all.
- **`approved_messaging`** (7 rows) — positioning, product-capability, and *cited*
  customer-proof statements (each with a source URL) for the reviewer to retrieve as
  supporting evidence when a claim is legitimately grounded.

### `corpus/approved-messaging.md`

The longer human-readable version of the same corpus — the actual document
`packages/reviewer`'s RAG ingest (LanceDB + `bge-small-en-v1.5`) chunks and embeds. Every
approved quote and cited statistic in `guidelines.json` also appears here in full prose
context, so retrieval has real passages to return, not just rule-row fragments.

### `corpus/assets/assets.json`

4 sample partner submissions, shaped as `ReviewRequest` — one clean, three with planted
violations, matching partner names from the Review Dashboard table in
`research/04-slides-and-demos.md`:

| Partner | Tier | Planted violations |
|---|---|---|
| **ABC Corp** | Select | **all six** `ClaimCategory` values in one submission (guaranteed_outcome + uncited_quantitative in one sentence, an unapproved superlative, an unapproved Morgan-Hale-at-KLZ quote, an Agent-Marketplace/Q4-2026 roadmap leak, and a Select partner misusing the Elite-only "Powered by KLZ Orchestrate" badge) — this is the row the demo shows as **RETURNED** |
| **Northland Analytics** | Elite | none — a *cited* stat, concrete capability language, no quotes/roadmap/badge issues — should score **APPROVED** |
| **Victorly** | Registered | `uncited_quantitative` (an uncited "40%") + `badge_tier_misuse` (a Registered partner using the Select-only "KLZ Select Partner" designation) |
| **BrightPath** | Elite | `unapproved_superlative` only ("best-in-class", "no other partner has gone as deep") — a minor, single-category RETURNED |

## How `mstack seed` loads this

Per `research/06-architecture.md` §5.2 (`pnpm mstack seed`), each file feeds a different
part of the offline-first stack — none of this requires a network call or a credential:

1. **`signals.sample.jsonl`** → read by the default `SampleSource` (`SignalSource` seam,
   `packages/adapters-signals`) and written into the `memory` package's DuckDB warehouse
   as `Signal` rows — the same path a real `PostHogSource`/`SegmentWebhookSource` would
   write through.
2. **`accounts.sample.json`** → read by the default `sample` `EnrichmentProvider`
   (`packages/adapters-enrichment`) and returned as `EnrichmentRecord`s when the context
   engine resolves an account; merged into `Account.firmographic` /
   `Account.buyingCommittee` with `provenance` preserved per field.
3. **`corpus/guidelines.json`** → loaded into `memory`'s rule tables (the deterministic
   pre-scan reads `lexicon`/`denylist`/`allowlist`/`tier_map` rows directly) and into the
   `GuidelineCorpus` seam's rule surface.
4. **`corpus/approved-messaging.md`** → chunked + embedded into LanceDB via the
   `GuidelineCorpus.ingest()`/retrieve path, so `reviewer`'s judge step can pull top-k
   supporting passages per claim.
5. **`corpus/assets/assets.json`** → the fixtures `pnpm mstack demo` feeds to the
   `content-review` workflow as `ReviewRequest`s, producing `Review` + `Finding` rows and
   partner-email/review-export drafts with zero live Claude calls required to prove the
   wiring (with `ANTHROPIC_API_KEY` set, the same fixtures run through the live agent
   pipeline instead of the deterministic-only path).

## Validating the fixtures

`validate.test.ts` (this directory, package `@mstack/data`) imports the real zod schemas
from `@mstack/core` and asserts every row in every file above actually parses — plus the
ABC Corp / Northland Analytics content-marker checks described above. Per
`docs/build-conventions.md`, this test is **not run locally** (no local `pnpm install`/
`pnpm build` — the tablet OOMs on the native deps in other packages); it runs on Spark as
part of `pnpm install && pnpm -r build && pnpm -r test` after each wave.
