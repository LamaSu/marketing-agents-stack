/**
 * Domain primitives for the Marketing Agents Stack — the shared vocabulary every
 * package speaks. One Zod schema library validates inbound webhooks, agent
 * structured-output, and persistence (in-process, no Python).
 *
 * See research/06-architecture.md §1.2 for the design rationale.
 *
 * MECHANICAL GUARDRAIL #1 (reviewer != generator): note that `ReviewResult` has
 * NO field for generated marketing prose. `Finding.recommendedChange` is a short
 * instruction, never a drafted replacement paragraph. Do not add such a field.
 */
import { z } from "zod";

/* ─────────────────────────── shared enums ─────────────────────────── */

export const SignalKind = z.enum(["product_usage", "crm", "campaign", "intent", "identify"]);
export type SignalKind = z.infer<typeof SignalKind>;

/** Partner tiers (Saqib demo): drives the badge/tier compliance check. */
export const PartnerTier = z.enum(["Registered", "Select", "Elite"]);
export type PartnerTier = z.infer<typeof PartnerTier>;

/** ICP fit tiers for account scoring (Guan demo). */
export const AccountTier = z.enum(["STRONG_FIT", "FIT", "PARTIAL_FIT", "DISQUALIFIED"]);
export type AccountTier = z.infer<typeof AccountTier>;

/** The six claim-drift / brand-violation categories (from the Portal demo). */
export const ClaimCategory = z.enum([
  "guaranteed_outcome",
  "uncited_quantitative",
  "unapproved_superlative",
  "unapproved_spokesperson_quote",
  "roadmap_disclosure",
  "badge_tier_misuse",
]);
export type ClaimCategory = z.infer<typeof ClaimCategory>;

export const GuidelineType = z.enum([
  "lexicon",
  "allowlist",
  "denylist",
  "approved_messaging",
  "tier_map",
]);
export type GuidelineType = z.infer<typeof GuidelineType>;

export const DetectedBy = z.enum(["deterministic", "claude", "nli"]);
export type DetectedBy = z.infer<typeof DetectedBy>;

export const Severity = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof Severity>;

export const ReviewVerdict = z.enum(["APPROVED", "RETURNED"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const ContentType = z.enum([
  "blog",
  "press_release",
  "case_study",
  "social",
  "email",
  "landing_page",
  "other",
]);
export type ContentType = z.infer<typeof ContentType>;

export const DraftKind = z.enum(["partner_email", "outreach_email", "review_export"]);
export type DraftKind = z.infer<typeof DraftKind>;

export const DraftStatus = z.enum(["pending", "approved", "rejected", "dispatched"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const ApprovalDecision = z.enum(["approve", "reject", "edit"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const OutcomeResult = z.enum([
  "sent",
  "replied",
  "meeting",
  "published",
  "returned",
  "no_response",
]);
export type OutcomeResult = z.infer<typeof OutcomeResult>;

export const Persona = z.enum(["Engineering", "Product", "Security", "Marketing", "Exec", "Other"]);
export type Persona = z.infer<typeof Persona>;

export const AgentMode = z.enum(["copilot", "autopilot"]);
export type AgentMode = z.infer<typeof AgentMode>;

/* ─────────────────────── shared sub-objects ───────────────────────── */

export const Span = z.object({ start: z.number().int(), end: z.number().int() });
export type Span = z.infer<typeof Span>;

/** field -> source, e.g. { "employees": "gleif", "tech": "techdetect" } */
export const Provenance = z.record(z.string(), z.string());
export type Provenance = z.infer<typeof Provenance>;

export const Firmographic = z.object({
  employees: z.number().int().nullable().optional(),
  industry: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  tech: z.array(z.string()).default([]),
});
export type Firmographic = z.infer<typeof Firmographic>;

export const CommitteeMember = z.object({
  name: z.string(),
  role: z.string(),
  persona: Persona,
  influence: z.string().optional(), // e.g. "Key Technical Influence"
});
export type CommitteeMember = z.infer<typeof CommitteeMember>;

export const RelevantSignal = z.object({
  signalId: z.string(),
  why: z.string(), // one sentence: why this signal matters now
});
export type RelevantSignal = z.infer<typeof RelevantSignal>;

export const NextBestAction = z.object({
  action: z.string(),
  channel: z.string(),
  targetMember: z.string(),
});
export type NextBestAction = z.infer<typeof NextBestAction>;

/* ───────────────────────── the 10 primitives ─────────────────────── */

/** One normalized event — the ingest atom. Segment-tracking-spec shaped. */
export const Signal = z.object({
  id: z.string(),
  ts: z.string(), // ISO-8601
  source: z.string(), // "posthog" | "github" | "segment" | "sample" | ...
  kind: SignalKind,
  actor: z.object({
    userId: z.string().optional(),
    anonId: z.string().optional(),
    email: z.string().optional(),
    company: z.string().optional(), // domain or name
    handle: z.string().optional(),
  }),
  action: z.string().optional(), // "downloaded_whitepaper", "opened_email", ...
  traits: z.record(z.string(), z.unknown()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  raw: z.unknown().optional(),
});
export type Signal = z.infer<typeof Signal>;

/** A resolved company + its rolled-up context. */
export const Account = z.object({
  id: z.string(),
  domain: z.string(),
  name: z.string(),
  firmographic: Firmographic,
  provenance: Provenance.default({}),
  signalRefs: z.array(z.string()).default([]),
  score: z.number().min(0).max(100).nullable().optional(),
  tier: AccountTier.nullable().optional(),
  lifecycleStage: z.string().nullable().optional(),
  buyingCommittee: z.array(CommitteeMember).default([]),
  lastScoredAt: z.string().nullable().optional(),
});
export type Account = z.infer<typeof Account>;

/** An atomic check-worthy assertion pulled from an asset. */
export const Claim = z.object({
  id: z.string(),
  assetId: z.string(),
  text: z.string(),
  span: Span.optional(),
  category: ClaimCategory.nullable().optional(),
  checkWorthy: z.boolean(),
  extractedBy: DetectedBy.default("claude"),
});
export type Claim = z.infer<typeof Claim>;

/** One entry of the north-star corpus / rule-set. */
export const Guideline = z.object({
  id: z.string(),
  category: z.string(), // free-form grouping; the six ClaimCategory values are common
  type: GuidelineType,
  content: z.string(),
  severity: Severity.default("medium"),
  source: z.string(),
  version: z.string().default("1"),
  embeddingId: z.string().optional(),
});
export type Guideline = z.infer<typeof Guideline>;

/**
 * One categorized claim-drift / brand violation.
 * `recommendedChange` is a targeted INSTRUCTION, never drafted replacement prose (guardrail #1).
 * `supportingPassageId` = the approved-corpus evidence id, or null = unsupported.
 */
export const Finding = z.object({
  id: z.string(),
  reviewId: z.string(),
  claimId: z.string().optional(),
  category: ClaimCategory,
  required: z.boolean(),
  quote: z.string(),
  span: Span.optional(),
  recommendedChange: z.string(),
  supportingPassageId: z.string().nullable(),
  detectedBy: DetectedBy,
  severity: Severity,
});
export type Finding = z.infer<typeof Finding>;

/** The reviewer's verdict on one asset. */
export const Review = z.object({
  id: z.string(),
  assetId: z.string(),
  partnerId: z.string(),
  partnerTier: PartnerTier,
  score: z.number().int().min(1).max(5),
  changesCount: z.number().int().min(0),
  verdict: ReviewVerdict,
  findings: z.array(Finding),
  draftedEmailId: z.string().optional(),
  exportRefs: z.object({ word: z.string().optional(), gdocs: z.string().optional() }).default({}),
  status: z.string().default("open"),
  createdAt: z.string(),
});
export type Review = z.infer<typeof Review>;

/** The account-intel brief (next-best-action). */
export const Decision = z.object({
  id: z.string(),
  accountId: z.string(),
  ts: z.string(),
  score: z.number().min(0).max(100),
  tier: AccountTier,
  relevantSignals: z.array(RelevantSignal),
  buyingCommittee: z.array(CommitteeMember),
  nextBestAction: NextBestAction,
  rationale: z.string(),
  byAgent: z.string(),
  mode: AgentMode,
});
export type Decision = z.infer<typeof Decision>;

/** A candidate external action — NEVER auto-sent. Only `dispatch.ts` + an Approval move it to `dispatched`. */
export const Draft = z.object({
  id: z.string(),
  kind: DraftKind,
  refId: z.string(), // account | partner | review id
  subject: z.string().optional(),
  body: z.string(),
  channel: z.string().default("email"),
  status: DraftStatus.default("pending"),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Draft = z.infer<typeof Draft>;

/** One HITL decision, hash-chained into the audit log. */
export const Approval = z.object({
  id: z.string(),
  draftId: z.string().optional(),
  reviewId: z.string().optional(),
  decision: ApprovalDecision,
  actor: z.string(),
  note: z.string().optional(),
  ts: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});
export type Approval = z.infer<typeof Approval>;

/** Closed-loop result of an action. */
export const Outcome = z.object({
  id: z.string(),
  refType: z.enum(["draft", "decision", "review"]),
  refId: z.string(),
  result: OutcomeResult,
  metrics: z.record(z.string(), z.unknown()).optional(),
  ts: z.string(),
});
export type Outcome = z.infer<typeof Outcome>;

/* ───────────────── agent I/O contracts (reviewer) ─────────────────── */

export const ReviewRequest = z.object({
  partnerId: z.string(),
  partnerTier: PartnerTier,
  contentTitle: z.string(),
  contentType: ContentType,
  content: z.string(),
});
export type ReviewRequest = z.infer<typeof ReviewRequest>;

/**
 * The reviewer AGENT output (pre-persistence): findings without db ids.
 * NOTE: no field carries generated marketing prose (guardrail #1).
 */
export const FindingDraft = z.object({
  category: ClaimCategory,
  required: z.boolean(),
  quote: z.string(),
  span: Span.optional(),
  recommendedChange: z.string(),
  supportingPassageId: z.string().nullable(),
  detectedBy: DetectedBy,
  severity: Severity,
});
export type FindingDraft = z.infer<typeof FindingDraft>;

export const ReviewResult = z.object({
  score: z.number().int().min(1).max(5),
  changesCount: z.number().int().min(0),
  verdict: ReviewVerdict,
  findings: z.array(FindingDraft),
  summary: z.string(), // a reviewer NOTE (not content)
});
export type ReviewResult = z.infer<typeof ReviewResult>;

/* ─────────────── agent I/O contracts (account-intel) ──────────────── */

export const ActivateAccount = z.object({
  accountRef: z.object({ domain: z.string(), name: z.string().optional() }),
  window: z.object({ since: z.string() }).optional(),
  mode: AgentMode.default("copilot"),
});
export type ActivateAccount = z.infer<typeof ActivateAccount>;

export const AccountDecision = z.object({
  account: z.object({ domain: z.string(), name: z.string() }),
  score: z.number().min(0).max(100),
  tier: AccountTier,
  relevantSignals: z.array(RelevantSignal),
  buyingCommittee: z.array(CommitteeMember),
  nextBestAction: NextBestAction,
  rationale: z.string(),
});
export type AccountDecision = z.infer<typeof AccountDecision>;

/* ─────────────── rubric: changesCount -> score (Portal demo) ──────── */

export const RUBRIC: ReadonlyArray<{ maxChanges: number; score: 1 | 2 | 3 | 4 | 5 }> = [
  { maxChanges: 0, score: 5 },
  { maxChanges: 2, score: 4 },
  { maxChanges: 3, score: 3 },
  { maxChanges: 4, score: 2 },
  { maxChanges: Number.POSITIVE_INFINITY, score: 1 },
];

/** Map a required-changes count to the 1-5 rubric score. */
export function scoreForChanges(changesCount: number): 1 | 2 | 3 | 4 | 5 {
  for (const band of RUBRIC) {
    if (changesCount <= band.maxChanges) return band.score;
  }
  return 1;
}
