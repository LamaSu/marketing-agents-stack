# @mstack/memory

The compounding data warehouse for the Marketing Agents Stack. `MemoryRepo` persists and reads every domain primitive from `@mstack/core` (Signal, Account, Claim, Guideline, Finding, Review, Decision, Draft, Approval, Outcome) in an embedded [DuckDB](https://duckdb.org) file via [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) — one table per primitive, the full object stored as a JSON `data` column plus a few indexed columns for the query paths the rest of the stack needs (`accountId`/`assetId`/`refId`/`ts`-shaped lookups), plus a generic `query(sql, params)` escape hatch for the scoring/analytics path. `Approval` rows are additionally written to an **append-only, hash-chained audit table** (`appendApproval` / `verifyAuditChain`), which is what makes guardrail #2 ("a human approves every send") and guardrail #3 ("compounding memory is the point") mechanical rather than aspirational — see `research/06-architecture.md` §1.2 and §8.

## Usage

```ts
import { openMemory } from "@mstack/memory";

const memory = await openMemory(); // reads DATA_DIR env (default ./.data), opens ./.data/memory.duckdb
// or: await openMemory(":memory:") for tests / ephemeral runs

await memory.putSignal(signal);
const signals = await memory.getSignalsForAccount("figma.com");

const approval = await memory.appendApproval({ id, draftId, decision: "approve", actor: "human", ts });
await memory.verifyAuditChain(); // true — until someone edits history out from under it

await memory.close();
```

## Single-writer discipline

DuckDB is a single-writer embedded database. This package's contract is **one shared `MemoryRepo` instance per process**, created once via `openMemory()` at startup and passed to whatever needs it (chorus steps, the apps) — never opened repeatedly against the same file from concurrent writers. `openMemory()` does not cache/memoize internally (each call opens a fresh connection, which matters for test isolation with `:memory:`); sharing a single instance is the caller's responsibility. When concurrency needs outgrow single-writer DuckDB, swap the backing store to Postgres behind this same `MemoryRepo` interface (`research/06-architecture.md` §2) — DuckDB stays as the embedded analytics engine, no rewrite required.

## Config

- `DATA_DIR` env (default `./.data`) — the warehouse file is `${DATA_DIR}/memory.duckdb`. This is a filesystem path, not a credential; this package never reads secrets from `process.env` (all keys are brokered by `gatecraft` elsewhere in the stack).
- Pass `":memory:"` explicitly to `openMemory()` for an in-memory database (used by this package's own tests).

## External audit export (halo-record)

`exportAuditHalo(memory)` / `writeHaloAudit(memory, path)` map the `approvals`
chain into [halo-record](https://github.com/bkuan001/halo-record)'s
(Apache-2.0) "Halo Runtime Record" schema — SHA-256 over RFC 8785
(JSON Canonicalization Scheme) canonical bytes, `integrity.prev_hash` /
`integrity.hash` linkage, 64-zeros genesis — so an **external** `halo verify`
(a separate Python CLI; never vendored here) can independently confirm the
chain was never tampered with, without trusting this codebase. This is a
read-only EXPORTER: `appendApproval`/`verifyAuditChain` above are untouched.
See `packages/memory/src/halo-export.ts` for the exact field mapping and its
`mstack export-audit --format halo [--out <file>]` CLI wiring in `apps/cli`.

```ts
import { exportAuditHalo, verifyHaloChain, writeHaloAudit } from "@mstack/memory";

const records = await exportAuditHalo(memory); // HaloRecord[]
await writeHaloAudit(memory, "./audit/halo-export.json");
verifyHaloChain(records); // true — an in-repo mirror of halo's own algorithm; run the real `halo verify` for an independent check
```

## Assumptions made against the `@duckdb/node-api` ("Neo") client

Written without running `pnpm install`/`pnpm test` locally per `docs/build-conventions.md` (the dev tablet OOMs on native deps) — verify these on the Spark build:

- `DuckDBInstance.create(path)` (file path or `:memory:`) → `instance.connect()` → `DuckDBConnection`, and `connection.run(sql, paramsObject)` / `connection.runAndReadAll(sql, paramsObject)` accept a plain object of named parameters (`$name` placeholders) with type inference (no explicit type map needed) — confirmed against the published `duckdb-node-neo` README and DuckDB's Node Neo client docs.
- `reader.getRowObjects()` returns plain objects keyed by column name — confirmed against the README.
- `connection.disconnectSync()` closes a connection — confirmed against the README.
- `CREATE INDEX IF NOT EXISTS` support could **not** be confirmed from the docs. Nothing in this package's correctness depends on indexes existing, so `init()` creates indexes best-effort (each wrapped individually, non-fatal on error) — table creation, which is load-bearing, uses only plain `CREATE TABLE IF NOT EXISTS`.
- The audit chain's ordering column (`approvals.seq`) is assigned in application code (`MAX(seq)+1`, read-then-write) rather than via a DuckDB `CREATE SEQUENCE`, specifically to avoid depending on sequence grammar this package couldn't verify without a live DuckDB.
- Every primitive is stored as JSON text in a `VARCHAR data` column rather than DuckDB's native `JSON` type, to avoid depending on the `json` extension being installed/loaded. This is a deliberate simplicity choice, not an API uncertainty.
