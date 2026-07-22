/** @mstack/memory — the compounding warehouse: a DuckDB-backed repository for
 *  every domain primitive, plus the append-only hash-chained Approval audit log.
 *  See research/06-architecture.md §2 (state-store split) and §1.2 (primitives). */
export * from "./memory-repo.js";
/** halo-record-format external audit export (research/10-sota-integration-design.md §2.11) — an exporter only, the internal chain above is untouched. */
export * from "./halo-export.js";
