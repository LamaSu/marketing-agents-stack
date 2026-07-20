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
 *  2. A plain low weighted score that happens to fall below `partialFit` (see tiers.ts)
 *     -- e.g. an account with no firmographic data and no signals. Also DISQUALIFIED,
 *     but for a different reason (no evidence of fit, not "must not contact").
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
  /** signal `action` values counted as high purchase-intent; +10 per unique match, capped at +20. */
  highIntentActions?: string[];
  /** signal `action` values that hard-disqualify the account outright (e.g. opt-out). */
  disqualifyingActions?: string[];
  /** substring-matched (case-insensitive) against `firmographic.industry`; hard disqualifier. */
  disqualifyingIndustries?: string[];
  /** exact-matched (case-insensitive) against `firmographic.region`; hard disqualifier. */
  disqualifyingRegions?: string[];
  /** signals newer than this many days count as "recent"; +10 bonus. */
  recentDays?: number;
  /** injectable clock for the recency check (tests / reproducibility). Defaults to `Date.now`. */
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
  recentDays: 14,
  now: Date.now,
};

interface RuleHit {
  label: string;
  points: number;
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

    const hits = [...this.#firmographicHits(account), ...this.#signalHits(signals)];
    const raw = hits.reduce((sum, h) => sum + h.points, 0);
    const score = clampScore(raw);
    const tier = tierForScore(score);
    const rationale =
      hits.length > 0
        ? `${hits.map((h) => `${h.label} (+${h.points})`).join(", ")} -- total ${score}/100 -> ${tier}.`
        : `no firmographic data or signals matched any rule -- ${score}/100 -> ${tier}.`;

    return { score, tier, rationale };
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

  #signalHits(signals: Signal[]): RuleHit[] {
    if (signals.length === 0) return [];
    const hits: RuleHit[] = [];

    hits.push({ label: `${signals.length} signal(s)`, points: Math.min(signals.length * 2, 20) });

    const distinctKinds = new Set(signals.map((s) => s.kind));
    if (distinctKinds.size > 1) {
      hits.push({
        label: `${distinctKinds.size} distinct signal kinds (multi-channel)`,
        points: Math.min(distinctKinds.size * 5, 15),
      });
    }

    const highIntent = new Set(
      signals
        .filter((s) => s.action !== undefined && this.#config.highIntentActions.includes(s.action))
        .map((s) => s.action as string),
    );
    if (highIntent.size > 0) {
      hits.push({ label: `high-intent action(s) [${[...highIntent].join(", ")}]`, points: Math.min(highIntent.size * 10, 20) });
    }

    const newestTs = signals.reduce((max, s) => (s.ts > max ? s.ts : max), signals[0]?.ts ?? "");
    if (newestTs) {
      const ageDays = (this.#config.now() - new Date(newestTs).getTime()) / 86_400_000;
      if (ageDays <= this.#config.recentDays) {
        hits.push({ label: `recent activity (<${this.#config.recentDays}d)`, points: 10 });
      }
    }

    return hits;
  }
}
