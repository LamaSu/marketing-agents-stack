/**
 * @mstack/memory — the compounding warehouse.
 *
 * `MemoryRepo` persists and reads every domain primitive from `@mstack/core`
 * (Signal, Account, Claim, Guideline, Finding, Review, Decision, Draft,
 * Approval, Outcome) against an embedded DuckDB file, one table per
 * primitive: the full validated object as a JSON `data` column, plus a
 * handful of indexed columns (id + natural foreign keys like
 * accountId/assetId/refId/ts) for the query paths the rest of the stack
 * needs. See research/06-architecture.md §2 (state-store split) and §1.2
 * (primitives).
 *
 * MECHANICAL GUARDRAIL #2/#3: `Approval` rows are additionally written to
 * an append-only, hash-chained audit table (never updated in place) —
 * `appendApproval` computes `hash = sha256Hex(prevHash + canonical(rest))`
 * and `verifyAuditChain()` recomputes the whole chain to detect tampering.
 *
 * SINGLE-WRITER DISCIPLINE: DuckDB is a single-writer embedded database.
 * This package's contract is *one shared `MemoryRepo` instance per
 * process*, created once via `openMemory()` (the factory below) and passed
 * to whatever needs it — chorus steps, the apps — never opened repeatedly
 * against the same file from concurrent processes/writers. `openMemory()`
 * does NOT memoize/cache internally (each call opens a fresh connection —
 * important for test isolation with `:memory:`); callers own sharing a
 * single instance. When concurrency needs outgrow single-writer DuckDB,
 * swap the backing store to Postgres behind this same `MemoryRepo`
 * interface (research/06-architecture.md §2) — DuckDB stays as the
 * embedded/analytics engine.
 *
 * ASSUMPTIONS ABOUT THE `@duckdb/node-api` ("Neo") CLIENT (verify on the
 * Spark build — this package was written without running `pnpm install`
 * locally per docs/build-conventions.md):
 *   - `DuckDBInstance.create(path)` accepts a file path or ":memory:";
 *     `instance.connect()` returns a `DuckDBConnection`. Confirmed against
 *     the published duckdb-node-neo README.
 *   - `connection.run(sql, paramsObject)` and `connection.runAndReadAll(sql,
 *     paramsObject)` accept a plain object of *named* parameters (`$name`
 *     placeholders) with JS values (string/number/boolean/null) and infer
 *     DuckDB types automatically — no explicit type map required. Confirmed
 *     against DuckDB's Node Neo client docs ("Unspecified types will be
 *     inferred").
 *   - `reader.getRowObjects()` returns an array of plain objects keyed by
 *     column name. Confirmed against the README.
 *   - `connection.disconnectSync()` closes a connection. Confirmed against
 *     the README.
 *   - `CREATE INDEX IF NOT EXISTS` support could NOT be confirmed from the
 *     docs alone. Because none of the CRUD/audit correctness depends on
 *     indexes existing, index creation in `init()` is deliberately
 *     best-effort (each statement individually try/caught, non-fatal) so a
 *     missing `IF NOT EXISTS` grammar can't break the whole package —
 *     table creation (which IS load-bearing) uses only bog-standard
 *     `CREATE TABLE IF NOT EXISTS`.
 *   - Everything is stored as JSON text in a VARCHAR `data` column rather
 *     than DuckDB's native JSON type, to avoid any dependency on the json
 *     extension being installed/loaded. This is a deliberate simplicity
 *     choice, not an API assumption.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";

import {
  Signal,
  Account,
  Claim,
  Guideline,
  Finding,
  Review,
  Decision,
  Draft,
  Approval,
  Outcome,
  DraftStatus,
  GENESIS_HASH,
  sha256Hex,
} from "@mstack/core";
import type { GuidelineType } from "@mstack/core";

/* ─────────────────────────── canonical JSON ────────────────────────────
 * Deterministic serialization (recursively sorted object keys) so the
 * audit hash is stable regardless of property insertion order, and so a
 * direct edit to any field of a stored Approval changes the recomputed
 * hash. */

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON.stringify — recursively sorts object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/* ─────────────────────────────── schema ─────────────────────────────── */

type TableName =
  | "signals"
  | "accounts"
  | "claims"
  | "guidelines"
  | "findings"
  | "reviews"
  | "decisions"
  | "drafts"
  | "outcomes"
  | "approvals";

const CREATE_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS signals (
     id VARCHAR PRIMARY KEY,
     ts VARCHAR NOT NULL,
     company VARCHAR,
     kind VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id VARCHAR PRIMARY KEY,
     domain VARCHAR,
     tier VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS claims (
     id VARCHAR PRIMARY KEY,
     asset_id VARCHAR,
     category VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS guidelines (
     id VARCHAR PRIMARY KEY,
     type VARCHAR,
     category VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS findings (
     id VARCHAR PRIMARY KEY,
     review_id VARCHAR,
     category VARCHAR,
     severity VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reviews (
     id VARCHAR PRIMARY KEY,
     asset_id VARCHAR,
     partner_id VARCHAR,
     status VARCHAR,
     verdict VARCHAR,
     created_at VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS decisions (
     id VARCHAR PRIMARY KEY,
     account_id VARCHAR,
     ts VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS drafts (
     id VARCHAR PRIMARY KEY,
     ref_id VARCHAR,
     status VARCHAR,
     created_at VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS outcomes (
     id VARCHAR PRIMARY KEY,
     ref_id VARCHAR,
     ref_type VARCHAR,
     ts VARCHAR,
     data VARCHAR NOT NULL
   )`,
  // Append-only hash-chained audit log. `seq` orders the chain (assigned in
  // application code from MAX(seq)+1 — see appendApproval — rather than a
  // DuckDB SEQUENCE object, to avoid depending on CREATE SEQUENCE grammar
  // this package couldn't verify without running pnpm install locally).
  `CREATE TABLE IF NOT EXISTS approvals (
     seq BIGINT PRIMARY KEY,
     id VARCHAR NOT NULL,
     ts VARCHAR NOT NULL,
     prev_hash VARCHAR NOT NULL,
     hash VARCHAR NOT NULL,
     data VARCHAR NOT NULL
   )`,
];

const CREATE_INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_signals_company ON signals(company)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_asset ON claims(asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guidelines_type ON guidelines(type)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_partner ON reviews(partner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_account ON decisions(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_ref ON drafts(ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_ref ON outcomes(ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_id ON approvals(id)`,
];

/** Input to `appendApproval` — everything except the fields the chain itself computes. */
export type NewApproval = Omit<Approval, "prevHash" | "hash">;

/* ─────────────────────────────── repo ───────────────────────────────── */

export class MemoryRepo {
  /** Prefer `openMemory()` over calling this directly — see the file-header
   *  note on single-writer discipline. Kept public for tests/advanced use. */
  constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {
    void this.instance; // held to keep the native instance alive for the connection's lifetime
  }

  /** Idempotent — safe to call every time a repo is opened against an existing file. */
  async init(): Promise<void> {
    for (const stmt of CREATE_TABLE_STATEMENTS) {
      await this.conn.run(stmt);
    }
    for (const stmt of CREATE_INDEX_STATEMENTS) {
      try {
        await this.conn.run(stmt);
      } catch (err) {
        // Best-effort: indexes are a performance aid, not a correctness
        // dependency for anything in this package. See file-header note.
        console.warn(`[@mstack/memory] index creation skipped: ${String(err)}`);
      }
    }
  }

  /* ── Signal ── */

  async putSignal(signal: Signal): Promise<void> {
    const parsed = Signal.parse(signal);
    await this.upsertRow("signals", {
      id: parsed.id,
      ts: parsed.ts,
      company: parsed.actor.company ?? null,
      kind: parsed.kind,
      data: JSON.stringify(parsed),
    });
  }

  async getSignalsForAccount(
    company: string,
    opts?: { since?: string; limit?: number },
  ): Promise<Signal[]> {
    const clauses = ["company = $company"];
    const params: Record<string, unknown> = { company };
    if (opts?.since) {
      clauses.push("ts >= $since");
      params.since = opts.since;
    }
    let sql = `SELECT data FROM signals WHERE ${clauses.join(" AND ")} ORDER BY ts ASC`;
    if (opts?.limit) {
      sql += ` LIMIT $limit`;
      params.limit = opts.limit;
    }
    const rows = await this.query<{ data: string }>(sql, params);
    return rows.map((r) => Signal.parse(JSON.parse(String(r.data))));
  }

  /* ── Account ── */

  async putAccount(account: Account): Promise<void> {
    const parsed = Account.parse(account);
    await this.upsertRow("accounts", {
      id: parsed.id,
      domain: parsed.domain,
      tier: parsed.tier ?? null,
      data: JSON.stringify(parsed),
    });
  }

  async getAccount(id: string): Promise<Account | null> {
    const rows = await this.query<{ data: string }>(
      "SELECT data FROM accounts WHERE id = $id",
      { id },
    );
    const row = rows[0];
    return row ? Account.parse(JSON.parse(row.data)) : null;
  }

  /* ── Claim ── */

  async putClaim(claim: Claim): Promise<void> {
    const parsed = Claim.parse(claim);
    await this.upsertRow("claims", {
      id: parsed.id,
      asset_id: parsed.assetId,
      category: parsed.category ?? null,
      data: JSON.stringify(parsed),
    });
  }

  async getClaimsForAsset(assetId: string): Promise<Claim[]> {
    const rows = await this.query<{ data: string }>(
      "SELECT data FROM claims WHERE asset_id = $assetId",
      { assetId },
    );
    return rows.map((r) => Claim.parse(JSON.parse(String(r.data))));
  }

  /* ── Guideline ── */

  async putGuideline(guideline: Guideline): Promise<void> {
    const parsed = Guideline.parse(guideline);
    await this.upsertRow("guidelines", {
      id: parsed.id,
      type: parsed.type,
      category: parsed.category,
      data: JSON.stringify(parsed),
    });
  }

  async listGuidelines(opts?: { type?: GuidelineType; category?: string }): Promise<Guideline[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts?.type) {
      clauses.push("type = $type");
      params.type = opts.type;
    }
    if (opts?.category) {
      clauses.push("category = $category");
      params.category = opts.category;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.query<{ data: string }>(`SELECT data FROM guidelines ${where}`, params);
    return rows.map((r) => Guideline.parse(JSON.parse(String(r.data))));
  }

  /* ── Review (+ denormalized Finding rows for the analytics path) ── */

  async putReview(review: Review): Promise<void> {
    const parsed = Review.parse(review);
    await this.upsertRow("reviews", {
      id: parsed.id,
      asset_id: parsed.assetId,
      partner_id: parsed.partnerId,
      status: parsed.status,
      verdict: parsed.verdict,
      created_at: parsed.createdAt,
      data: JSON.stringify(parsed),
    });

    // Findings live inside Review.findings (source of truth) but are also
    // denormalized into their own table so `query()` can do cross-review
    // analytics (e.g. "all high-severity guaranteed_outcome findings this
    // month") without scanning every review's JSON blob.
    await this.conn.run("DELETE FROM findings WHERE review_id = $reviewId", { reviewId: parsed.id });
    for (const finding of parsed.findings) {
      await this.conn.run(
        `INSERT INTO findings (id, review_id, category, severity, data) VALUES ($id, $reviewId, $category, $severity, $data)`,
        {
          id: finding.id,
          reviewId: finding.reviewId,
          category: finding.category,
          severity: finding.severity,
          data: JSON.stringify(finding),
        },
      );
    }
  }

  async listReviews(opts?: { status?: string; partnerId?: string }): Promise<Review[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts?.status) {
      clauses.push("status = $status");
      params.status = opts.status;
    }
    if (opts?.partnerId) {
      clauses.push("partner_id = $partnerId");
      params.partnerId = opts.partnerId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.query<{ data: string }>(
      `SELECT data FROM reviews ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map((r) => Review.parse(JSON.parse(String(r.data))));
  }

  /** Cross-review Finding lookup (Finding also lives inline on its parent Review). */
  async getFindingsForReview(reviewId: string): Promise<Finding[]> {
    const rows = await this.query<{ data: string }>(
      "SELECT data FROM findings WHERE review_id = $reviewId",
      { reviewId },
    );
    return rows.map((r) => Finding.parse(JSON.parse(String(r.data))));
  }

  /* ── Decision ── */

  async putDecision(decision: Decision): Promise<void> {
    const parsed = Decision.parse(decision);
    await this.upsertRow("decisions", {
      id: parsed.id,
      account_id: parsed.accountId,
      ts: parsed.ts,
      data: JSON.stringify(parsed),
    });
  }

  /* ── Draft ── */

  async putDraft(draft: Draft): Promise<void> {
    const parsed = Draft.parse(draft);
    await this.upsertRow("drafts", {
      id: parsed.id,
      ref_id: parsed.refId,
      status: parsed.status,
      created_at: parsed.createdAt,
      data: JSON.stringify(parsed),
    });
  }

  async getDraft(id: string): Promise<Draft | null> {
    const rows = await this.query<{ data: string }>("SELECT data FROM drafts WHERE id = $id", { id });
    const row = rows[0];
    return row ? Draft.parse(JSON.parse(row.data)) : null;
  }

  async setDraftStatus(id: string, status: DraftStatus): Promise<void> {
    DraftStatus.parse(status);
    const existing = await this.getDraft(id);
    if (!existing) {
      throw new Error(`setDraftStatus: no draft with id "${id}"`);
    }
    await this.putDraft({ ...existing, status });
  }

  /* ── Outcome ── */

  async putOutcome(outcome: Outcome): Promise<void> {
    const parsed = Outcome.parse(outcome);
    await this.upsertRow("outcomes", {
      id: parsed.id,
      ref_id: parsed.refId,
      ref_type: parsed.refType,
      ts: parsed.ts,
      data: JSON.stringify(parsed),
    });
  }

  /* ── Approval — append-only, hash-chained audit log ── */

  async appendApproval(input: NewApproval): Promise<Approval> {
    const last = await this.query<{ seq: unknown; hash: string }>(
      "SELECT seq, hash FROM approvals ORDER BY seq DESC LIMIT 1",
    );
    const lastRow = last[0];
    const prevSeq = lastRow ? Number(lastRow.seq) : 0;
    const prevHash = lastRow ? String(lastRow.hash) : GENESIS_HASH;

    // Hash the CANONICAL, PARSED approval — exactly the bytes that will be
    // stored — not the raw `input`. Parsing through the schema WITHOUT `hash`
    // first strips any extra/stray field on `input` (including a stray
    // `hash`/`prevHash`) and applies the server-set `prevHash`, so the invariant
    // holds: what is hashed === what is stored === what `verifyAuditChain`
    // recomputes (which hashes the stored row minus its own `hash`). Hashing the
    // raw `input` instead let any extra field make the stored hash
    // unrecomputable from the stored data and permanently break the chain.
    // For a well-formed input with no extras this yields the byte-identical hash
    // to before (the Approval schema sets no defaults), so pre-existing chains
    // still verify unchanged.
    const unhashed = Approval.omit({ hash: true }).parse({ ...input, prevHash });
    const hash = sha256Hex(prevHash + canonicalJson(unhashed));
    const approval = Approval.parse({ ...unhashed, hash });

    await this.conn.run(
      `INSERT INTO approvals (seq, id, ts, prev_hash, hash, data) VALUES ($seq, $id, $ts, $prevHash, $hash, $data)`,
      {
        seq: prevSeq + 1,
        id: approval.id,
        ts: approval.ts,
        prevHash: approval.prevHash,
        hash: approval.hash,
        data: JSON.stringify(approval),
      },
    );
    return approval;
  }

  /** Recomputes the whole chain from row 1 and returns false on the first mismatch
   *  (broken linkage, tampered payload, or a row that no longer parses as an Approval). */
  async verifyAuditChain(): Promise<boolean> {
    const rows = await this.query<{ data: string }>("SELECT data FROM approvals ORDER BY seq ASC");
    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      let approval: Approval;
      try {
        approval = Approval.parse(JSON.parse(String(row.data)));
      } catch {
        return false;
      }
      if (approval.prevHash !== expectedPrev) return false;
      const { hash, ...rest } = approval;
      if (sha256Hex(approval.prevHash + canonicalJson(rest)) !== hash) return false;
      expectedPrev = hash;
    }
    return true;
  }

  /* ── generic escape hatch for the scoring/analytics path ── */

  /** Raw parameterized SQL. Bind untrusted values via `$name` placeholders in
   *  `params` — never string-interpolate them into `sql`. */
  async query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
    const reader = params
      ? await this.conn.runAndReadAll(sql, params as Record<string, DuckDBValue>)
      : await this.conn.runAndReadAll(sql);
    // Double-cast: the client's exact row-object type isn't verified here (see
    // file-header assumptions), so go through `unknown` rather than assume it
    // overlaps `T` enough for a direct assertion.
    return reader.getRowObjects() as unknown as T[];
  }

  async close(): Promise<void> {
    this.conn.disconnectSync();
  }

  /* ── internal ── */

  private async upsertRow(table: TableName, columns: Record<string, unknown>): Promise<void> {
    const id = columns["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`upsertRow: ${table} row must have a non-empty string "id"`);
    }
    await this.conn.run(`DELETE FROM ${table} WHERE id = $id`, { id });
    const keys = Object.keys(columns);
    const colList = keys.join(", ");
    const paramList = keys.map((k) => `$${k}`).join(", ");
    await this.conn.run(`INSERT INTO ${table} (${colList}) VALUES (${paramList})`, columns as Record<string, DuckDBValue>);
  }
}

/* ─────────────────────────── open factory ───────────────────────────── */

function resolveDbPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const dir = process.env.DATA_DIR ?? "./.data";
  return join(dir, "memory.duckdb");
}

/**
 * Opens (creating if needed) the shared compounding-memory warehouse and
 * runs migrations. Defaults to `${DATA_DIR}/memory.duckdb` (DATA_DIR env,
 * default `./.data`) — pass `":memory:"` explicitly for an ephemeral
 * database (used by this package's own tests). Does not read any secret
 * from `process.env` — DATA_DIR is a filesystem path, not a credential.
 *
 * Each call opens a fresh instance/connection (no internal caching): hold
 * onto ONE returned `MemoryRepo` per process and share it, per the
 * single-writer discipline documented at the top of this file.
 */
export async function openMemory(path?: string): Promise<MemoryRepo> {
  const target = resolveDbPath(path);
  if (target !== ":memory:") {
    await mkdir(dirname(target), { recursive: true });
  }
  const instance = await DuckDBInstance.create(target);
  const connection = await instance.connect();
  const repo = new MemoryRepo(instance, connection);
  await repo.init();
  return repo;
}
