import { describe, it, expect } from "vitest";
import { Signal } from "@mstack/core";

import { SqlWarehouseSource, type SqlQueryFn } from "./sql-warehouse-source.js";

const ROW = {
  id: "sig_wh_1",
  ts: "2026-07-20T00:00:00.000Z",
  source: "sql-warehouse",
  kind: "crm",
  actor: { company: "figma.com" },
  action: "renewal_upcoming",
};

describe("SqlWarehouseSource", () => {
  it("maps rows from an injected query() fn (shape matching MemoryRepo.query) to valid Signals", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const query: SqlQueryFn = async (sql, params) => {
      calls.push({ sql, params });
      return [{ data: JSON.stringify(ROW) }];
    };
    const source = new SqlWarehouseSource({ query });
    const signals = await source.pull();

    expect(signals).toHaveLength(1);
    expect(() => Signal.parse(signals[0])).not.toThrow();
    expect(signals[0]?.id).toBe("sig_wh_1");
    expect(calls[0]?.sql).toContain("SELECT data FROM signals");
  });

  it("also accepts an already-parsed object in the data column (not just a JSON string)", async () => {
    const query: SqlQueryFn = async () => [{ data: ROW }];
    const source = new SqlWarehouseSource({ query });
    const signals = await source.pull();
    expect(signals[0]?.id).toBe("sig_wh_1");
  });

  it("threads PullOptions.since into the default query's WHERE clause", async () => {
    let seenSql = "";
    let seenParams: Record<string, unknown> | undefined;
    const query: SqlQueryFn = async (sql, params) => {
      seenSql = sql;
      seenParams = params;
      return [];
    };
    const source = new SqlWarehouseSource({ query });
    await source.pull({ since: "2026-01-01T00:00:00.000Z" });

    expect(seenSql).toContain("WHERE ts >= $since");
    expect(seenParams?.["since"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("threads PullOptions.limit into the default query", async () => {
    let seenSql = "";
    const query: SqlQueryFn = async (sql) => {
      seenSql = sql;
      return [];
    };
    await new SqlWarehouseSource({ query }).pull({ limit: 25 });
    expect(seenSql).toContain("LIMIT $limit");
  });

  it("supports a fully custom sql + mapRow for a differently-shaped warehouse", async () => {
    const query: SqlQueryFn = async () => [
      {
        signal_id: "sig_custom_1",
        occurred_at: "2026-07-20T00:00:00.000Z",
        company_domain: "vercel.com",
        event_name: "pricing_page_viewed",
      },
    ];
    const source = new SqlWarehouseSource({
      query,
      sql: "SELECT signal_id, occurred_at, company_domain, event_name FROM my_events",
      mapRow: (row) => ({
        id: row["signal_id"],
        ts: row["occurred_at"],
        source: "sql-warehouse",
        kind: "campaign",
        actor: { company: row["company_domain"] },
        action: row["event_name"],
      }),
    });
    const signals = await source.pull();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe("sig_custom_1");
    expect(signals[0]?.actor.company).toBe("vercel.com");
  });

  it('has a configurable name, default "sql-warehouse"', () => {
    const query: SqlQueryFn = async () => [];
    expect(new SqlWarehouseSource({ query }).name).toBe("sql-warehouse");
    expect(new SqlWarehouseSource({ query, name: "postgres-mart" }).name).toBe("postgres-mart");
  });
});
