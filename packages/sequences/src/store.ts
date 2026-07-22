/**
 * store.ts — package-local persistence for sequences and their runs.
 *
 * WHY THIS IS HERE AND NOT IN `@mstack/memory`: a cadence is an orchestration layered on top
 * of the existing primitives, so its tables live with the feature, not in the core warehouse
 * schema. This store adds its two tables through `MemoryRepo`'s PUBLIC generic `query()`
 * escape hatch (the same DuckDB connection, one shared writer) — it does NOT modify
 * `memory-repo.ts`. `init()` is idempotent (`CREATE TABLE IF NOT EXISTS`), mirroring
 * `MemoryRepo#init`, so it is safe to run every time the store is opened.
 *
 * STORAGE SHAPE follows the rest of the warehouse: the full validated object as a JSON `data`
 * column, plus a few indexed columns (id + natural keys) for the query paths this feature
 * needs. Upsert is DELETE-then-INSERT — exactly what `MemoryRepo#upsertRow` does — to avoid
 * depending on `INSERT ... ON CONFLICT` grammar this package can't verify without a local
 * `pnpm install` (see `memory-repo.ts`'s file-header note on the DuckDB Neo client).
 *
 * DUCKDB-NEO ASSUMPTION (consistent with `memory-repo.ts`): `MemoryRepo#query` wraps
 * `connection.runAndReadAll(sql, params)`. For CREATE/DELETE/INSERT statements that return no
 * rows, `runAndReadAll` still executes the statement and `getRowObjects()` yields `[]` — so
 * `query()` is a valid path for DDL/DML here, not just SELECTs. None of this store's
 * correctness depends on a write returning rows.
 */
import type { MemoryRepo } from "@mstack/memory";

import { Sequence, SequenceRun, SequenceRunStatus } from "./types.js";

const CREATE_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sequences (
     id VARCHAR PRIMARY KEY,
     name VARCHAR,
     data VARCHAR NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sequence_runs (
     id VARCHAR PRIMARY KEY,
     sequence_id VARCHAR,
     account_ref VARCHAR,
     status VARCHAR,
     data VARCHAR NOT NULL
   )`,
];

/** Persists `Sequence` templates and their live `SequenceRun`s in the shared warehouse. */
export class SequenceStore {
  readonly #memory: MemoryRepo;

  constructor(memory: MemoryRepo) {
    this.#memory = memory;
  }

  /** Idempotent DDL — safe to call every open. Uses only `CREATE TABLE IF NOT EXISTS`. */
  async init(): Promise<void> {
    for (const stmt of CREATE_TABLE_STATEMENTS) {
      await this.#memory.query(stmt);
    }
  }

  /* ── Sequence templates ── */

  async saveSequence(sequence: Sequence): Promise<Sequence> {
    const parsed = Sequence.parse(sequence);
    await this.#memory.query("DELETE FROM sequences WHERE id = $id", { id: parsed.id });
    await this.#memory.query(
      "INSERT INTO sequences (id, name, data) VALUES ($id, $name, $data)",
      { id: parsed.id, name: parsed.name, data: JSON.stringify(parsed) },
    );
    return parsed;
  }

  async getSequence(id: string): Promise<Sequence | null> {
    const rows = await this.#memory.query<{ data: string }>(
      "SELECT data FROM sequences WHERE id = $id",
      { id },
    );
    const row = rows[0];
    return row ? Sequence.parse(JSON.parse(String(row.data))) : null;
  }

  /* ── Live runs ── */

  async saveRun(run: SequenceRun): Promise<SequenceRun> {
    const parsed = SequenceRun.parse(run);
    await this.#memory.query("DELETE FROM sequence_runs WHERE id = $id", { id: parsed.id });
    await this.#memory.query(
      `INSERT INTO sequence_runs (id, sequence_id, account_ref, status, data)
       VALUES ($id, $sequenceId, $accountRef, $status, $data)`,
      {
        id: parsed.id,
        sequenceId: parsed.sequenceId,
        accountRef: parsed.accountRef,
        status: parsed.status,
        data: JSON.stringify(parsed),
      },
    );
    return parsed;
  }

  async getRun(id: string): Promise<SequenceRun | null> {
    const rows = await this.#memory.query<{ data: string }>(
      "SELECT data FROM sequence_runs WHERE id = $id",
      { id },
    );
    const row = rows[0];
    return row ? SequenceRun.parse(JSON.parse(String(row.data))) : null;
  }

  /** Observability path — list runs, optionally filtered by status / account / sequence. */
  async listRuns(opts?: {
    status?: SequenceRunStatus;
    accountRef?: string;
    sequenceId?: string;
  }): Promise<SequenceRun[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts?.status) {
      SequenceRunStatus.parse(opts.status);
      clauses.push("status = $status");
      params.status = opts.status;
    }
    if (opts?.accountRef) {
      clauses.push("account_ref = $accountRef");
      params.accountRef = opts.accountRef;
    }
    if (opts?.sequenceId) {
      clauses.push("sequence_id = $sequenceId");
      params.sequenceId = opts.sequenceId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.#memory.query<{ data: string }>(
      `SELECT data FROM sequence_runs ${where}`,
      params,
    );
    return rows.map((r) => SequenceRun.parse(JSON.parse(String(r.data))));
  }
}

/** Open (and migrate) a `SequenceStore` over an already-open shared `MemoryRepo`. */
export async function openSequenceStore(memory: MemoryRepo): Promise<SequenceStore> {
  const store = new SequenceStore(memory);
  await store.init();
  return store;
}
