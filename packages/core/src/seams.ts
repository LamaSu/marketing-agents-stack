/**
 * The five adapter seams. Every external dependency sits behind one of these with a
 * `sample`/offline default; real providers are opt-in and swap in without anything
 * downstream changing. See research/06-architecture.md §5.1.
 *
 * MECHANICAL GUARDRAIL #2 (human approves every send): `OutreachChannel.dispatch`
 * REQUIRES an `Approval` argument — a channel structurally cannot send without one.
 * Implementations MUST verify the approval matches the draft and is `approve`.
 */
import type {
  Account,
  Approval,
  Draft,
  Firmographic,
  Guideline,
  Outcome,
  Provenance,
  Signal,
  AccountTier,
  CommitteeMember,
} from "./schemas.js";

/* ───────────────────────── seam I/O types ─────────────────────────── */

export interface EnrichmentRecord {
  domain: string;
  name?: string;
  firmographic: Firmographic;
  contacts?: CommitteeMember[];
  /** field -> source, so callers can resolve conflicts by trust, not averaging. */
  provenance: Provenance;
  source: string; // which provider produced it
}

export interface ScoreResult {
  score: number; // 0-100
  tier: AccountTier;
  /** agent-actionable reason a bare number can't give (LLM/hybrid scorers fill this). */
  rationale?: string;
}

export interface RetrievedPassage {
  id: string;
  content: string;
  score: number; // similarity
}

export interface PullOptions {
  since?: string; // ISO-8601 lower bound
  limit?: number;
}

/* ──────────────────────────── the seams ───────────────────────────── */

/** SignalSource — the ingest atom producer. Default impl: SampleSource over a JSONL fixture. */
export interface SignalSource {
  readonly name: string;
  pull(opts?: PullOptions): Promise<Signal[]>;
}

/** EnrichmentProvider — resolve a company ref to a firmographic record with provenance. */
export interface EnrichmentProvider {
  readonly name: string;
  /** returns null if the provider has nothing for this ref. */
  enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null>;
}

/** ScoringProvider — the noise filter. Rules / Claude-cold-start / ONNX / Hybrid. */
export interface ScoringProvider {
  readonly name: string;
  score(account: Account, signals: Signal[]): Promise<ScoreResult>;
}

/** GuidelineCorpus — the reviewer's north star (RAG over approved messaging + the rule tables). */
export interface GuidelineCorpus {
  ingest(guidelines: Guideline[]): Promise<void>;
  /** top-k approved-messaging passages for "is this claim supported?". */
  retrieve(query: string, k: number): Promise<RetrievedPassage[]>;
  /** the deterministic rule rows (lexicon | allowlist | denylist | tier_map). */
  rules(): Promise<Guideline[]>;
}

/**
 * OutreachChannel — draft-first. There is intentionally NO `send(draft)` method.
 * The only way to dispatch is to supply a matching, approved `Approval`.
 */
export interface OutreachChannel {
  readonly name: string;
  readonly kind: string; // "email" | "slack" | ...
  /** Send ONLY given a valid approval. Implementations must assert:
   *  approval.decision === "approve" && approval.draftId === draft.id && draft.status === "approved". */
  dispatch(draft: Draft, approval: Approval): Promise<Outcome>;
}
