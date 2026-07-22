/**
 * RulesScorer -- the always-on, zero-dependency, fully offline ICP-fit floor. See
 * research/tools/D-warehouse-scoring.md ("RulesScorer -- pure TS. Weighted firmographic
 * + engagement rules -> 0-100. Always-on baseline, zero deps, fully offline,
 * deterministic/explainable.") and research/06-architecture.md §3.2 ("RulesScorer is
 * the always-on floor + hard disqualifiers").
 *
 * Every contribution is transparent: `rationale` lists exactly which rule fired and how
 * many points it added -- never a bare number a human or downstream agent has to trust
 * blind.
 *
 * Two distinct ways an account ends up DISQUALIFIED:
 *  1. A HARD disqualifier (`#hardDisqualifiers`) -- an explicit do-not-contact signal,
 *     or a denylisted industry/region. Short-circuits to score 0, tier DISQUALIFIED,
 *     and the rationale starts with "DISQUALIFIED:" naming the exact rule that fired.
 *     `fit`/`intent` are NOT computed on this path -- nothing to report, the account is
 *     out regardless of any sub-score (see hybrid-scorer.ts's "hard floor").
 *  2. A plain low weighted score that happens to fall below `partialFit` (see tiers.ts)
 *     -- e.g. an account with no firmographic data and no signals. Also DISQUALIFIED,
 *     but for a different reason (no evidence of fit, not "must not contact"). `fit`/
 *     `intent` ARE computed on this path -- both will simply be low/zero.
 *
 * FIT x INTENT SPLIT + TIME DECAY (research/10-sota-integration-design.md §2.6, points
 * 2-3 -- the MadKudu-shaped 2-model split, composed here as one scorer's two sub-totals
 * rather than two separate models):
 *  - `fit` = the firmographic/technographic sub-score (`#firmographicHits` -- company
 *    size, industry, region, tech stack: durable facts about the ACCOUNT).
 *  - `intent` = the behavioral/signal sub-score (`#signalHits` -- signal volume, channel
 *    diversity, high-intent actions, recency: facts about recent ACTIVITY).
 *  - `score` stays the single blended headline (`clamp(fit + intent)`) -- unchanged
 *    shape, just reported alongside its two components instead of only as one number.
 *  - Every signal-derived point inside `intent` is weighted by `decayWeight()`, an
 *    exponential half-life decay over the signal's age (default 90 days, configurable
 *    via `signalHalfLifeDays`) -- so a purchase-intent signal from 8 months ago no
 *    longer counts nearly as much as one from yesterday. At age 0 every weight is 1, so
 *    an all-fresh-signals input reduces to exactly the old (pre-decay) point totals --
 *    decay only ever pulls stale intent DOWN, it never inflates a fresh one.
 */
import { tierForScore, clampScore } from "./tiers.js";
import type { ScoringProvider, ScoreResult, Account, Signal } from "@mstack/core";

export interface RulesScorerConfig {
  /** substring-matched (case-insensitive) against `firmographic.industry`; +15. */
  targetIndustries?: string[];
  /** exact-matched (case-insensitive) against `firmographic.region`; +10. */
  targetRegions?: string[];
  /** matched (case-insensitive) against `firmographic.tech`; +5 per match, capped at +15. */
  targetTech?: string[];
  /** signal `action` values counted as high purchase-intent; +10 per unique match
   *  (age-decayed), capped at +20. */
  highIntentActions?: string[];
  /** signal `action` values that hard-disqualify the account outright (e.g. opt-out). */
  disqualifyingActions?: string[];
  /** substring-matched (case-insensitive) against `firmographic.industry`; hard disqualifier. */
  disqualifyingIndustries?: string[];
  /** exact-matched (case-insensitive) against `firmographic.region`; hard disqualifier. */
  disqualifyingRegions?: string[];
  /** Half-life, in days, for time-decaying signal-derived `intent` contributions -- a
   *  signal this many days old contributes half the points an identical signal today
   *  would, a quarter at 2x this, etc. Default 90 (MadKudu-shaped, per
   *  research/10-sota-integration-design.md §2.6 point 3). Supersedes the old flat
   *  `recentDays` cutoff with a continuous decay -- see `decayWeight()`. */
  signalHalfLifeDays?: number;
  /** injectable clock for the recency/decay check (tests / reproducibility). Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULTS: Required<RulesScorerConfig> = {
  targetIndustries: ["software", "saas", "technology", "developer tools", "cloud", "infrastructure"],
  targetRegions: ["US", "EU", "UK", "CA"],
  targetTech: ["react", "aws", "kubernetes", "postgres", "segment", "typescript"],
  highIntentActions: ["requested_demo", "pricing_page_view", "booked_meeting", "started_trial"],
  disqualifyingActions: ["unsubscribed", "do_not_contact", "spam_report", "opted_out"],
  disqualifyingIndustries: [],
  disqualifyingRegions: [],
  signalHalfLifeDays: 90,
  now: Date.now,
};

interface RuleHit {
  label: string;
  points: number;
}

/**
 * Exponential half-life decay: 1.0 at age 0, 0.5 at `halfLifeDays`, 0.25 at
 * `2 * halfLifeDays`, etc. -- `weight = 0.5 ^ (ageDays / halfLifeDays)`. A pure function
 * (no clock access) so it is directly unit-testable and so `#signalHits` can compute
 * every signal's weight against one fixed `nowMs` snapshot instead of drifting mid-computation.
 *
 * Clamped/defensive rather than throwing: a signal's age should never be able to crash a
 * score. `ageDays <= 0` (a future-dated or exactly-now signal) is full weight 1;
 * non-finite `ageDays` or a non-positive/non-finite `halfLifeDays` degrades to 0
 * (maximally stale) rather than propagating `NaN`/`Infinity` into the rest of the score.
 */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= 0) return 1;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Age, in days, of a Signal relative to `nowMs`. Clamped at 0 -- a future-dated
 * timestamp (clock skew, a bad fixture) must never produce a decay BONUS. An
 * unparseable `ts` degrades to `+Infinity` (maximally stale -> `decayWeight` returns 0)
 * rather than throwing or leaking `NaN` into the score.
 */
export function signalAgeDays(signal: Signal, nowMs: number): number {
  const ts = new Date(signal.ts).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - ts) / 86_400_000);
}

export class RulesScorer implements ScoringProvider {
  readonly name = "rules";
  readonly #config: Required<RulesScorerConfig>;

  constructor(config: RulesScorerConfig = {}) {
    this.#config = { ...DEFAULTS, ...config };
  }

  async score(account: Account, signals: Signal[]): Promise<ScoreResult> {
    const disqualifiers = this.#hardDisqualifiers(account, signals);
    if (disqualifiers.length > 0) {
      return { score: 0, tier: "DISQUALIFIED", rationale: `DISQUALIFIED: ${disqualifiers.join("; ")}.` };
    }

    const fitHits = this.#firmographicHits(account);
    const intentHits = this.#signalHits(signals);
    const hits = [...fitHits, ...intentHits];

    const fitRaw = fitHits.reduce((sum, h) => sum + h.points, 0);
    const intentRaw = intentHits.reduce((sum, h) => sum + h.points, 0);

    // `score` stays the single blended headline -- identical arithmetic to the pre-split
    // implementation (sum of every hit, clamped), just computed via two named partial
    // sums instead of one flat reduce so they can also be reported individually below.
    const score = clampScore(fitRaw + intentRaw);
    const fit = clampScore(fitRaw);
    const intent = clampScore(intentRaw);
    const tier = tierForScore(score);
    const rationale =
      hits.length > 0
        ? `${hits.map((h) => `${h.label} (+${h.points})`).join(", ")} -- total ${score}/100 -> ${tier}.`
        : `no firmographic data or signals matched any rule -- ${score}/100 -> ${tier}.`;

    return { score, tier, fit, intent, rationale };
  }

  #hardDisqualifiers(account: Account, signals: Signal[]): string[] {
    const reasons: string[] = [];
    const { disqualifyingActions, disqualifyingIndustries, disqualifyingRegions } = this.#config;

    const hitAction = signals.find((s) => s.action !== undefined && disqualifyingActions.includes(s.action));
    if (hitAction) reasons.push(`signal action '${hitAction.action}' is disqualifying (do-not-contact)`);

    const industry = account.firmographic.industry?.toLowerCase() ?? "";
    if (industry && disqualifyingIndustries.some((d) => industry.includes(d.toLowerCase()))) {
      reasons.push(`industry '${account.firmographic.industry}' is disqualifying`);
    }

    const region = account.firmographic.region?.toUpperCase() ?? "";
    if (region && disqualifyingRegions.some((d) => d.toUpperCase() === region)) {
      reasons.push(`region '${account.firmographic.region}' is disqualifying`);
    }

    return reasons;
  }

  /** Firmographic/technographic hits only -- the `fit` sub-score. Durable facts about
   *  the account; nothing here is signal- or time-derived. Unchanged from the pre-split
   *  implementation. */
  #firmographicHits(account: Account): RuleHit[] {
    const hits: RuleHit[] = [];
    const { employees, industry, region, tech } = account.firmographic;

    if (employees !== null && employees !== undefined) {
      let band: RuleHit;
      if (employees >= 1000) band = { label: "employees 1000+ (enterprise)", points: 35 };
      else if (employees >= 250) band = { label: "employees 250-999 (mid-market)", points: 25 };
      else if (employees >= 50) band = { label: "employees 50-249 (growth)", points: 15 };
      else band = { label: "employees <50 (small)", points: 5 };
      hits.push(band);
    }

    const industryLower = industry?.toLowerCase() ?? "";
    if (industryLower && this.#config.targetIndustries.some((t) => industryLower.includes(t.toLowerCase()))) {
      hits.push({ label: `target industry match (${industry})`, points: 15 });
    }

    if (region && this.#config.targetRegions.some((r) => r.toUpperCase() === region.toUpperCase())) {
      hits.push({ label: `target region match (${region})`, points: 10 });
    }

    const techMatches = tech.filter((t) => this.#config.targetTech.some((want) => want.toLowerCase() === t.toLowerCase()));
    if (techMatches.length > 0) {
      hits.push({ label: `tech stack overlap (${techMatches.join(", ")})`, points: Math.min(techMatches.length * 5, 15) });
    }

    return hits;
  }

  /**
   * Behavioral/signal hits only -- the `intent` sub-score. Every point here is derived
   * from signals and is age-decayed via `decayWeight()` against one fixed `nowMs`
   * snapshot (`this.#config.now()`, read once per call so every signal in this batch is
   * weighted against the same instant). At age 0 (every signal exactly "now"), every
   * weight is 1 and the totals below are numerically IDENTICAL to the pre-decay
   * implementation -- decay is a pure downward adjustment for staleness, it never adds.
   */
  #signalHits(signals: Signal[]): RuleHit[] {
    if (signals.length === 0) return [];
    const hits: RuleHit[] = [];
    const nowMs = this.#config.now();
    const halfLife = this.#config.signalHalfLifeDays;
    const weighted = signals.map((s) => ({ signal: s, weight: decayWeight(signalAgeDays(s, nowMs), halfLife) }));

    // 1. Signal volume -- was `signals.length * 2` capped at 20; now the SUM OF DECAY
    //    WEIGHTS times 2, so e.g. 10 signals from 8 months ago count for far less than
    //    10 signals from today instead of identically.
    const weightedCount = weighted.reduce((sum, w) => sum + w.weight, 0);
    if (weightedCount > 0) {
      hits.push({
        label: `${signals.length} signal(s), time-decayed volume ${weightedCount.toFixed(1)} (half-life ${halfLife}d)`,
        points: Math.min(weightedCount * 2, 20),
      });
    }

    // 2. Multi-channel -- each distinct `kind` contributes its FRESHEST signal's decay
    //    weight (not a flat 1 per kind), so a channel only ever touched long ago barely
    //    moves this.
    const kindFreshness = new Map<string, number>();
    for (const w of weighted) {
      const prev = kindFreshness.get(w.signal.kind) ?? 0;
      if (w.weight > prev) kindFreshness.set(w.signal.kind, w.weight);
    }
    if (kindFreshness.size > 1) {
      const kindWeightSum = [...kindFreshness.values()].reduce((sum, w) => sum + w, 0);
      hits.push({
        label: `${kindFreshness.size} distinct signal kinds (multi-channel), time-decayed ${kindWeightSum.toFixed(1)}`,
        points: Math.min(kindWeightSum * 5, 15),
      });
    }

    // 3. High-intent actions -- same freshest-occurrence decay treatment as #2.
    const highIntentFreshness = new Map<string, number>();
    for (const w of weighted) {
      const action = w.signal.action;
      if (action !== undefined && this.#config.highIntentActions.includes(action)) {
        const prev = highIntentFreshness.get(action) ?? 0;
        if (w.weight > prev) highIntentFreshness.set(action, w.weight);
      }
    }
    if (highIntentFreshness.size > 0) {
      const highIntentWeightSum = [...highIntentFreshness.values()].reduce((sum, w) => sum + w, 0);
      hits.push({
        label: `high-intent action(s) [${[...highIntentFreshness.keys()].join(", ")}], time-decayed ${highIntentWeightSum.toFixed(1)}`,
        points: Math.min(highIntentWeightSum * 10, 20),
      });
    }

    // 4. Freshness bonus -- a continuous version of the old binary "newest signal <
    //    recentDays -> +10" cliff: scales smoothly with the single freshest signal's
    //    decay weight, so e.g. 13-days-old and 15-days-old accounts no longer swing by a
    //    full +10 across one arbitrary threshold day. At weight 1 (age 0) this is +10,
    //    exactly matching the old flat bonus.
    const freshestWeight = weighted.reduce((max, w) => Math.max(max, w.weight), 0);
    const freshnessPoints = Math.round(freshestWeight * 10);
    if (freshnessPoints > 0) {
      hits.push({
        label: `signal freshness ${Math.round(freshestWeight * 100)}% (most-recent-signal decay weight, half-life ${halfLife}d)`,
        points: freshnessPoints,
      });
    }

    return hits;
  }
}
