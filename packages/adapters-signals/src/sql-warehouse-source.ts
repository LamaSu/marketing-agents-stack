/**
 * SqlWarehouseSource -- pull-style SignalSource over an injected `query(sql, params)` function,
 * the "bring-your-own-warehouse" path (research/06-architecture.md §5.1). The injected `query`
 * fn's shape intentionally matches @mstack/memory's `MemoryRepo.query(sql, params?)` -- this
 * package does NOT depend on @mstack/memory (adapters stay decoupled from the specific
 * warehouse implementation); callers wire `memory.query.bind(memory)` (or any other
 * SQL-executing function with the same shape -- a Postgres/Snowflake/BigQuery client wrapper)
 * in at the runtime layer.
 *
 * DEFAULT query/mapping assumes a `signals` table shaped like @mstack/memory's own schema (a
 * `data` column holding a full serialized Signal) -- the natural case when this is pointed at
 * the SAME warehouse @mstack/memory already writes to, or one ETL'd to the same JSON shape.
 * Pass `sql` + `mapRow` to target a genuinely different table/warehouse.
 */
import { Signal } from "@mstack/core";
import type { PullOptions, SignalSource } from "@mstack/core";

/**
 * Matches the SHAPE of @mstack/memory's `MemoryRepo.query` -- sql + optional named params in,
 * an array of plain row objects out (see the file header). Deliberately NON-generic: this
 * adapter always consumes rows as `Record<string, unknown>` via `mapRow` (its one and only
 * call site below never needs a narrower row type), and a concrete signature here is safely
 * assignable both from a plain test fake and from a real `memory.query.bind(memory)`, without
 * depending on TypeScript's generic-function-assignability rules in either direction.
 */
export type SqlQueryFn = (sql: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;

export interface SqlWarehouseSourceConfig {
  name?: string;
  /** injected query executor -- see SqlQueryFn. */
  query: SqlQueryFn;
  /**
   * Fully custom parameterized SQL for a differently-shaped warehouse/engine. When provided,
   * this adapter does NOT build a WHERE/LIMIT clause for you -- your SQL owns filtering, using
   * whatever placeholder syntax your injected `query` implementation expects (e.g. DuckDB/
   * @mstack/memory-style `$name`, or driver-specific positional params). `since`/`limit` from
   * PullOptions are passed through as `{ since, limit }` entries in `params` in case your SQL
   * references them by name; merged with any static `params` you configure. When `sql` is
   * omitted, the default query IS DuckDB/@mstack/memory-flavored (`$since`/`$limit` named
   * placeholders), matching the natural default pairing described in the file header.
   */
  sql?: string;
  /** static bind params merged into every query (custom `sql` path only). */
  params?: Record<string, unknown>;
  /** maps one result row to the shape `Signal.parse` expects. Defaults to reading a `data`
   *  column (a JSON string OR an already-parsed object) -- @mstack/memory's `signals` table shape. */
  mapRow?: (row: Record<string, unknown>) => unknown;
}

const DEFAULT_SELECT = "SELECT data FROM signals";

function defaultMapRow(row: Record<string, unknown>): unknown {
  const data = row["data"];
  return typeof data === "string" ? JSON.parse(data) : data;
}

export class SqlWarehouseSource implements SignalSource {
  readonly name: string;
  readonly #query: SqlQueryFn;
  readonly #sql: string | undefined;
  readonly #staticParams: Record<string, unknown>;
  readonly #mapRow: (row: Record<string, unknown>) => unknown;

  constructor(config: SqlWarehouseSourceConfig) {
    this.name = config.name ?? "sql-warehouse";
    this.#query = config.query;
    this.#sql = config.sql;
    this.#staticParams = config.params ?? {};
    this.#mapRow = config.mapRow ?? defaultMapRow;
  }

  async pull(opts?: PullOptions): Promise<Signal[]> {
    const since = opts?.since;
    const limit = opts?.limit;
    const customSql = this.#sql;

    let sql: string;
    let params: Record<string, unknown>;

    if (customSql !== undefined) {
      params = { ...this.#staticParams };
      if (since !== undefined) params["since"] = since;
      if (limit !== undefined) params["limit"] = limit;
      sql = customSql;
    } else {
      const clauses: string[] = [];
      params = { ...this.#staticParams };
      if (since !== undefined) {
        clauses.push("ts >= $since");
        params["since"] = since;
      }
      sql =
        clauses.length > 0
          ? `${DEFAULT_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY ts ASC`
          : `${DEFAULT_SELECT} ORDER BY ts ASC`;
      if (limit !== undefined) {
        sql += " LIMIT $limit";
        params["limit"] = limit;
      }
    }

    const rows = await this.#query(sql, params);
    return rows.map((row) => Signal.parse(this.#mapRow(row)));
  }
}
