/**
 * @mstack/analytics — deterministic, offline funnel + conversion reporting over the
 * `MemoryRepo` warehouse (research/06-architecture.md §2). This is the funnel/dashboard
 * layer every incumbent (MadKudu, Outreach, Clearbit) ships as its core reporting
 * surface — built here as a thin, read-only aggregation layer, not a new data model.
 *
 * READ-ONLY, OFFLINE, DETERMINISTIC: every function below only ever calls
 * `memory.query()` (the generic escape hatch documented in
 * `packages/memory/src/memory-repo.ts`) with plain aggregate SQL. No writes, no
 * network, no LLM call, no row-by-row JS aggregation where SQL can do it (`GROUP BY`/
 * `COUNT`/`COUNT DISTINCT` do the counting; JS only does O(1) arithmetic — divisions,
 * zero-fills — over the handful of scalars SQL already aggregated). Every report
 * function is safe to call against a completely empty warehouse: it zero-fills rather
 * than crashing (see each function's own comment for how).
 *
 * THE FUNNEL (`funnelReport`):
 *
 *   signals ingested → accounts scored → decisions made → drafts created
 *   → drafts approved → dispatched (sent) → replied → meeting
 *
 * Table/column provenance for each stage was traced from `memory-repo.ts`'s
 * `CREATE TABLE` statements plus the real producer call sites (not assumed) — see
 * the SQL comment above `FUNNEL_SQL` for the exact mapping.
 *
 * NOTE on "conversion rate" > 100% between decisionsMade → draftsCreated: this repo
 * has TWO independent draft-producing workflows feeding the same `drafts` table —
 * content-review (`partner_email`/`review_export` drafts, keyed off a Review) and
 * account-activation (`outreach_email` drafts, keyed off a Decision). `draftsCreated`
 * counts drafts from BOTH workflows, while `decisionsMade` only counts the
 * account-activation half, so `draftsCreated` can legitimately exceed `decisionsMade` —
 * this is a real property of the two-workflow system, not a bug in the funnel math.
 *
 * BIGINT gotcha (load-bearing, see `packages/memory/src/memory-repo.ts`'s own
 * file-header + `executor.test.ts`'s `Number(rows[0]?.c ?? -1)` convention):
 * `@duckdb/node-api` returns `COUNT(*)`/`COUNT(DISTINCT ...)` as JS `bigint`, not
 * `number`. Every aggregate row type here types count columns as `number | bigint`
 * and converts via `toNum()` before use — a raw `bigint` would throw if this report
 * is ever `JSON.stringify`'d by a caller.
 */
import { AccountTier, ClaimCategory, ReviewVerdict, nowIso } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

/* ─────────────────────────────── shared helpers ────────────────────────────────── */

/** Options threaded through every report function; `now` is an injectable clock (tests only). */
export interface ReportOptions {
  now?: () => string;
}

function toNum(v: number | bigint | undefined | null): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "bigint" ? Number(v) : v;
}

/** `numerator / denominator`, 0 (not NaN/Infinity) when `denominator` is 0. */
function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/* ═══════════════════════════════ 1. funnelReport ═══════════════════════════════ */

export type FunnelStageKey =
  | "signalsIngested"
  | "accountsScored"
  | "decisionsMade"
  | "draftsCreated"
  | "draftsApproved"
  | "dispatched"
  | "replied"
  | "meeting";

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  count: number;
  /** `count / previousStage.count` (0 if the previous stage's count was 0); `null` for
   *  the first stage, which has no previous stage to convert from. */
  conversionFromPrevious: number | null;
}

export interface FunnelReport {
  stages: FunnelStage[];
  generatedAt: string;
}

interface FunnelRow {
  signals_ingested: number | bigint;
  accounts_scored: number | bigint;
  decisions_made: number | bigint;
  drafts_created: number | bigint;
  drafts_approved: number | bigint;
  dispatched: number | bigint;
  replied: number | bigint;
  meeting: number | bigint;
}

const FUNNEL_STAGE_ORDER: readonly FunnelStageKey[] = [
  "signalsIngested",
  "accountsScored",
  "decisionsMade",
  "draftsCreated",
  "draftsApproved",
  "dispatched",
  "replied",
  "meeting",
];

const FUNNEL_STAGE_LABELS: Record<FunnelStageKey, string> = {
  signalsIngested: "Signals ingested",
  accountsScored: "Accounts scored",
  decisionsMade: "Decisions made",
  draftsCreated: "Drafts created",
  draftsApproved: "Drafts approved",
  dispatched: "Dispatched (sent)",
  replied: "Replied",
  meeting: "Meeting booked",
};

/** Maps each funnel stage to the `FunnelRow` column it reads. */
const FUNNEL_ROW_KEY: Record<FunnelStageKey, keyof FunnelRow> = {
  signalsIngested: "signals_ingested",
  accountsScored: "accounts_scored",
  decisionsMade: "decisions_made",
  draftsCreated: "drafts_created",
  draftsApproved: "drafts_approved",
  dispatched: "dispatched",
  replied: "replied",
  meeting: "meeting",
};

/**
 * One row, 8 scalar subqueries — a single round trip. Column provenance:
 *   - signals_ingested:  COUNT(*) of `signals`                                 (every ingested Signal)
 *   - accounts_scored:   COUNT(*) of `accounts` WHERE tier IS NOT NULL          (tier is set only after
 *                        scoring — `activateAccount` step 2 re-`putAccount`s with `tier`; upsert-by-id
 *                        means one row per account always reflects the LATEST put)
 *   - decisions_made:    COUNT(*) of `decisions`                               (one per activateAccount run)
 *   - drafts_created:    COUNT(*) of `drafts`                                  (both workflows, see file header)
 *   - drafts_approved:   COUNT(*) of `drafts` WHERE status IN ('approved','dispatched') — 'dispatched'
 *                        implies it passed through 'approved' first (`dispatch.ts`'s own invariant: a
 *                        draft can only be dispatched from status 'approved'), so this also counts
 *                        already-sent drafts as having-been-approved.
 *   - dispatched:        COUNT(DISTINCT ref_id) of `outcomes` WHERE ref_type='draft' AND result='sent'
 *                        — `dispatch.ts`'s file header is explicit that the Outcome row (not the
 *                        channel, not `drafts.status`) is "what memory learns 'sent' from."
 *   - replied / meeting: same shape, result='replied' / result='meeting'. Neither producer exists in
 *                        this repo yet (schema-supported, not yet wired) — expected to read 0 until one
 *                        does; that is a correct, not a broken, empty state.
 */
const FUNNEL_SQL = `
  SELECT
    (SELECT COUNT(*) FROM signals) AS signals_ingested,
    (SELECT COUNT(*) FROM accounts WHERE tier IS NOT NULL) AS accounts_scored,
    (SELECT COUNT(*) FROM decisions) AS decisions_made,
    (SELECT COUNT(*) FROM drafts) AS drafts_created,
    (SELECT COUNT(*) FROM drafts WHERE status IN ('approved', 'dispatched')) AS drafts_approved,
    (SELECT COUNT(DISTINCT ref_id) FROM outcomes WHERE ref_type = 'draft' AND data LIKE '%"result":"sent"%') AS dispatched,
    (SELECT COUNT(DISTINCT ref_id) FROM outcomes WHERE ref_type = 'draft' AND data LIKE '%"result":"replied"%') AS replied,
    (SELECT COUNT(DISTINCT ref_id) FROM outcomes WHERE ref_type = 'draft' AND data LIKE '%"result":"meeting"%') AS meeting
`;
// NOTE: the `outcomes` table stores the Outcome as a JSON `data` blob (columns are
// id/ref_id/ref_type/ts/data — see memory-repo.ts); `result` is NOT a real column.
// This package avoids DuckDB's JSON extension (matching memory-repo's convention of
// parsing JSON in JS, never SQL-side), so we match the canonical serialized form:
// `Outcome.parse` → `JSON.stringify` always emits `"result":"<enum>"` verbatim, and
// `result` is a fixed enum, so this LIKE is exact for our data.

/** The GTM funnel (8 stages, stage-to-stage conversion rates) — see the file header for the exact
 *  stage list and the "conversion > 100%" note. Safe on an empty warehouse: every count is 0 and every
 *  conversion rate is 0 (except the first stage's, which is always `null` — there is no previous stage). */
export async function funnelReport(memory: MemoryRepo, opts: ReportOptions = {}): Promise<FunnelReport> {
  const rows = await memory.query<FunnelRow>(FUNNEL_SQL);
  const row = rows[0];

  const stages: FunnelStage[] = [];
  let previousCount: number | null = null;
  for (const key of FUNNEL_STAGE_ORDER) {
    const count = toNum(row?.[FUNNEL_ROW_KEY[key]]);
    const conversionFromPrevious =
      previousCount === null ? null : previousCount > 0 ? count / previousCount : 0;
    stages.push({ key, label: FUNNEL_STAGE_LABELS[key], count, conversionFromPrevious });
    previousCount = count;
  }

  return { stages, generatedAt: (opts.now ?? nowIso)() };
}

/* ═══════════════════════════ 2. conversionByTier ═══════════════════════════════ */

export interface TierConversion {
  tier: AccountTier;
  draftsCreated: number;
  sent: number;
  replied: number;
  meeting: number;
  /** sent / draftsCreated */
  sentRate: number;
  /** replied / sent */
  repliedRate: number;
  /** meeting / replied */
  meetingRate: number;
}

export interface ConversionByTierReport {
  tiers: TierConversion[];
  generatedAt: string;
}

interface TierRow {
  tier: string;
  drafts_created: number | bigint;
  sent: number | bigint;
  replied: number | bigint;
  meeting: number | bigint;
}

/**
 * Joins `accounts.tier` → `drafts` → `outcomes`, grouped by tier. The `drafts d ON
 * d.ref_id = a.id` join deliberately does NOT filter on draft `kind` (there is no `kind`
 * column on `drafts` — only `id/ref_id/status/created_at/data`; `kind` lives inside the
 * JSON `data` blob only). It doesn't need to: `refId` namespacing already disjoins the
 * two draft-producing workflows — `outreach_email` drafts carry `refId = account.id`
 * ("acc_...", `activate-account.ts`) while `partner_email`/`review_export` drafts carry
 * `refId = reviewId` ("rev_...", `review-agent.ts`) — different `newId()` prefixes, so a
 * content-review draft's `ref_id` can never match an `accounts.id` row. The join is
 * naturally exact without touching the JSON blob (this package avoids DuckDB's JSON
 * extension entirely, matching `memory-repo.ts`'s own documented choice not to depend on
 * it). `outcomes` joins similarly key off `ref_id = d.id` (a draft's own id — confirmed in
 * `dispatch.ts`: `refId: persisted.id`), with `ref_type = 'draft'` re-asserted defensively
 * per join.
 */
const TIER_CONVERSION_SQL = `
  SELECT
    a.tier AS tier,
    COUNT(DISTINCT d.id) AS drafts_created,
    COUNT(DISTINCT CASE WHEN s.ref_id IS NOT NULL THEN d.id END) AS sent,
    COUNT(DISTINCT CASE WHEN r.ref_id IS NOT NULL THEN d.id END) AS replied,
    COUNT(DISTINCT CASE WHEN m.ref_id IS NOT NULL THEN d.id END) AS meeting
  FROM accounts a
  JOIN drafts d ON d.ref_id = a.id
  LEFT JOIN outcomes s ON s.ref_id = d.id AND s.ref_type = 'draft' AND s.data LIKE '%"result":"sent"%'
  LEFT JOIN outcomes r ON r.ref_id = d.id AND r.ref_type = 'draft' AND r.data LIKE '%"result":"replied"%'
  LEFT JOIN outcomes m ON m.ref_id = d.id AND m.ref_type = 'draft' AND m.data LIKE '%"result":"meeting"%'
  WHERE a.tier IS NOT NULL
  GROUP BY a.tier
`;

/** Per-`AccountTier` conversion (sent/replied/meeting rates over that tier's outreach drafts).
 *  Always returns exactly one row per `AccountTier.options` value (STRONG_FIT/FIT/PARTIAL_FIT/
 *  DISQUALIFIED) — tiers with no accounts/drafts zero-fill in JS rather than being omitted, so the
 *  shape is stable for a dashboard/CLI regardless of what data exists. Deliberately avoids a SQL
 *  `VALUES(...)`-list / CTE for that zero-fill (this package was written without a local `pnpm
 *  install`, per docs/build-conventions.md, so unverified DuckDB grammar is avoided in favor of
 *  bog-standard `SELECT`/`JOIN`/`CASE WHEN`/`COUNT DISTINCT`/`GROUP BY`). */
export async function conversionByTier(
  memory: MemoryRepo,
  opts: ReportOptions = {},
): Promise<ConversionByTierReport> {
  const rows = await memory.query<TierRow>(TIER_CONVERSION_SQL);
  const byTier = new Map<string, TierRow>();
  for (const row of rows) {
    byTier.set(row.tier, row);
  }

  const tiers: TierConversion[] = AccountTier.options.map((tier) => {
    const row = byTier.get(tier);
    const draftsCreated = toNum(row?.drafts_created);
    const sent = toNum(row?.sent);
    const replied = toNum(row?.replied);
    const meeting = toNum(row?.meeting);
    return {
      tier,
      draftsCreated,
      sent,
      replied,
      meeting,
      sentRate: rate(sent, draftsCreated),
      repliedRate: rate(replied, sent),
      meetingRate: rate(meeting, replied),
    };
  });

  return { tiers, generatedAt: (opts.now ?? nowIso)() };
}

/* ═══════════════════════════ 3. reviewOutcomes ═══════════════════════════════ */

export interface ReviewVerdictCount {
  verdict: ReviewVerdict;
  count: number;
}

export interface ClaimDriftCategoryCount {
  category: ClaimCategory;
  count: number;
}

export interface ReviewOutcomesReport {
  totalReviews: number;
  verdicts: ReviewVerdictCount[];
  /** APPROVED count / totalReviews (0 if totalReviews is 0) */
  approvalRate: number;
  /** claim-drift categories from the denormalized `findings` table, ranked by count desc,
   *  capped at `opts.topCategories` (default 5). */
  topClaimDriftCategories: ClaimDriftCategoryCount[];
  generatedAt: string;
}

export interface ReviewOutcomesOptions extends ReportOptions {
  /** how many claim-drift categories to include (ranked by count desc). Default 5. */
  topCategories?: number;
}

const DEFAULT_TOP_CATEGORIES = 5;

interface VerdictRow {
  verdict: string;
  c: number | bigint;
}

interface CategoryRow {
  category: string;
  c: number | bigint;
}

/** APPROVED vs RETURNED counts (+ approval rate) from `reviews.verdict`, and the top
 *  claim-drift categories (+ counts) from the denormalized `findings.category` column
 *  (see `memory-repo.ts#putReview` — findings are denormalized out of `Review.findings`
 *  specifically so cross-review analytics like this don't need to scan every review's
 *  JSON blob). Every category value read back is re-validated via `ClaimCategory.safeParse`
 *  and silently dropped if it somehow fails (defensive; `Finding.category` is always a
 *  valid, non-nullable `ClaimCategory` at write time via `Review.parse`, so this should
 *  never trigger in practice — it exists so a corrupted row degrades the report, not crashes
 *  it, matching this package's "never crash on unexpected warehouse contents" contract). */
export async function reviewOutcomes(
  memory: MemoryRepo,
  opts: ReviewOutcomesOptions = {},
): Promise<ReviewOutcomesReport> {
  const topN = opts.topCategories ?? DEFAULT_TOP_CATEGORIES;

  const [verdictRows, categoryRows] = await Promise.all([
    memory.query<VerdictRow>(
      "SELECT verdict, COUNT(*) AS c FROM reviews WHERE verdict IS NOT NULL GROUP BY verdict",
    ),
    memory.query<CategoryRow>(
      "SELECT category, COUNT(*) AS c FROM findings WHERE category IS NOT NULL GROUP BY category ORDER BY c DESC",
    ),
  ]);

  const verdictCounts = new Map<string, number>();
  for (const row of verdictRows) {
    verdictCounts.set(row.verdict, toNum(row.c));
  }

  const verdicts: ReviewVerdictCount[] = ReviewVerdict.options.map((verdict) => ({
    verdict,
    count: verdictCounts.get(verdict) ?? 0,
  }));
  const totalReviews = verdicts.reduce((sum, v) => sum + v.count, 0);
  const approvedCount = verdictCounts.get("APPROVED") ?? 0;

  const topClaimDriftCategories: ClaimDriftCategoryCount[] = [];
  for (const row of categoryRows) {
    if (topClaimDriftCategories.length >= topN) break;
    const parsed = ClaimCategory.safeParse(row.category);
    if (parsed.success) {
      topClaimDriftCategories.push({ category: parsed.data, count: toNum(row.c) });
    }
  }

  return {
    totalReviews,
    verdicts,
    approvalRate: rate(approvedCount, totalReviews),
    topClaimDriftCategories,
    generatedAt: (opts.now ?? nowIso)(),
  };
}

/* ═══════════════════════════ 4. combined GTM report ═══════════════════════════════ */

export interface GtmReport {
  funnel: FunnelReport;
  tiers: ConversionByTierReport;
  reviews: ReviewOutcomesReport;
}

/** Convenience: runs all three reports in parallel and bundles them — what a future
 *  `mstack report` CLI command would call, and what `formatReport` below expects. */
export async function buildGtmReport(
  memory: MemoryRepo,
  opts: ReviewOutcomesOptions = {},
): Promise<GtmReport> {
  const [funnel, tiers, reviews] = await Promise.all([
    funnelReport(memory, opts),
    conversionByTier(memory, opts),
    reviewOutcomes(memory, opts),
  ]);
  return { funnel, tiers, reviews };
}

/* ═══════════════════════════════ formatting ═══════════════════════════════════ */

/** Matches `apps/cli/src/format.ts`'s `RULE` divider convention so this drops into that
 *  module unchanged (`console.log(formatReport(report))`) once a `mstack report` command exists. */
const SECTION_RULE = "─".repeat(72);

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Minimal dependency-free text table: two-space-gutter columns, header + `-` separator. */
function renderTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => r[i] ?? "");
    return Math.max(h.length, ...colValues.map((v) => v.length));
  });
  const renderRow = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

/** Renders just the funnel section as text — exported alongside `formatReport` since a
 *  future CLI may want to show one section at a time (e.g. `mstack report --funnel-only`). */
export function formatFunnelReport(report: FunnelReport): string {
  const rows = report.stages.map((s) => [
    s.label,
    String(s.count),
    s.conversionFromPrevious === null ? "—" : formatPct(s.conversionFromPrevious),
  ]);
  const table = renderTable(["Stage", "Count", "Conv. from prev."], rows);
  return [`GTM FUNNEL (as of ${report.generatedAt})`, table].join("\n");
}

/** Renders just the per-tier conversion section as text. */
export function formatConversionByTier(report: ConversionByTierReport): string {
  const rows = report.tiers.map((t) => [
    t.tier,
    String(t.draftsCreated),
    String(t.sent),
    formatPct(t.sentRate),
    String(t.replied),
    formatPct(t.repliedRate),
    String(t.meeting),
    formatPct(t.meetingRate),
  ]);
  const table = renderTable(
    ["Tier", "Drafts", "Sent", "Sent %", "Replied", "Reply %", "Meeting", "Meeting %"],
    rows,
  );
  return [`CONVERSION BY ACCOUNT TIER (as of ${report.generatedAt})`, table].join("\n");
}

/** Renders just the review-outcomes section as text. */
export function formatReviewOutcomes(report: ReviewOutcomesReport): string {
  const verdictTable = renderTable(
    ["Verdict", "Count"],
    report.verdicts.map((v) => [v.verdict, String(v.count)]),
  );
  const categoryRows = report.topClaimDriftCategories.map((c) => [c.category, String(c.count)]);
  const categoryTable =
    categoryRows.length > 0
      ? renderTable(["Claim-drift category", "Findings"], categoryRows)
      : "(no findings recorded)";

  return [
    `REVIEW OUTCOMES (as of ${report.generatedAt})`,
    `Total reviews: ${report.totalReviews}  ·  Approval rate: ${formatPct(report.approvalRate)}`,
    verdictTable,
    "",
    "Top claim-drift categories:",
    categoryTable,
  ].join("\n");
}

/** CLI-friendly text rendering of a combined `GtmReport` — what a future `mstack report`
 *  command prints as-is via `console.log(formatReport(report))`. */
export function formatReport(report: GtmReport): string {
  return [
    SECTION_RULE,
    formatFunnelReport(report.funnel),
    SECTION_RULE,
    formatConversionByTier(report.tiers),
    SECTION_RULE,
    formatReviewOutcomes(report.reviews),
    SECTION_RULE,
  ].join("\n");
}
