/**
 * @mstack/reviewer — lance-corpus.ts
 *
 * `LanceCorpus` implements the `GuidelineCorpus` seam (packages/core/src/
 * seams.ts) — the reviewer's north star: RAG over approved messaging (via
 * LanceDB) + the deterministic rule tables (exposed as-is via `rules()`, not
 * embedded). See research/06-architecture.md §3.1 context-pack items 3-4.
 *
 * TODO(wave3): `retrieve(query, k)` is what packages/agents' judge step
 * (research/06-architecture.md §3.1 pipeline step 4/5) calls per check-worthy
 * claim to build that claim's context pack — the top-k passages returned here
 * become the evidence the Claude judge cites as `supportingPassageId` (or
 * marks unsupported if nothing relevant comes back). `rules()` feeds
 * `rules.ts`'s `scanDeterministic()` (step 2) and the judge's brand-rule
 * context (step 5).
 *
 * LANCEDB API — every call below was confirmed live (2026-07-20) against
 * `@lancedb/lancedb`'s own shipped `.d.ts` files at v0.31.0, not run locally
 * (docs/build-conventions.md: no local `pnpm install`):
 *   - `connect(uri): Promise<Connection>` (`dist/index.d.ts`)
 *   - `db.createTable(name, rows, { mode: "overwrite" }): Promise<Table>` —
 *     `CreateTableOptions.mode: "create" | "overwrite"`; "overwrite" both
 *     creates-if-absent and replaces-if-present (`dist/connection.d.ts`), so
 *     `ingest()` doesn't need to special-case first-vs-later calls.
 *   - `table.vectorSearch(vector).distanceType("cosine").limit(k).toArray()` —
 *     `distanceType` accepts `"l2" | "cosine" | "dot"` (default "l2"); the
 *     README's basic example is `table.vectorSearch(v).limit(k).toArray()`
 *     (`dist/query.d.ts`, `dist/table.d.ts`).
 *   - Result rows carry a `_distance` column (documented in `VectorQuery`'s
 *     `.analyzePlan()` JSDoc example). For cosine distance this is
 *     `1 - cosine_similarity` (`dist/indices.d.ts`: "Cosine distance is a
 *     distance metric calculated from the cosine similarity between two
 *     vectors"), so `score = 1 - _distance` recovers a similarity in
 *     [-1, 1] before clamping to seams.ts's documented `[0,1]` "similarity".
 *   - `toArray(): Promise<any[]>` — the library itself types this `any[]`;
 *     this file narrows through `unknown` rather than propagate `any`
 *     further (same discipline packages/memory/src/memory-repo.ts uses for
 *     its own "the client's exact row type isn't verified" escape hatch).
 */
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { Guideline, GuidelineCorpus, RetrievedPassage } from "@mstack/core";

import type { Embedder } from "./embedder.js";
import { HuggingFaceEmbedder } from "./embedder.js";

const DEFAULT_TABLE_NAME = "guideline_passages";

export interface LanceCorpusOptions {
  /** Directory `lancedb.connect()` opens (created if missing). Pass a
   *  temp dir or a fixed on-disk path; there is no dedicated in-memory URI
   *  scheme confirmed for this client version, so tests use a real
   *  `fs.mkdtemp` directory instead (see lance-corpus.test.ts). */
  dbPath: string;
  /** Injectable per the corpus layer's task spec — swap `FakeEmbedder` in
   *  tests, `HuggingFaceEmbedder` (the default via `createLanceCorpus`) for
   *  real runs, or any other `Embedder` implementation. */
  embedder: Embedder;
  tableName?: string;
}

interface PassageRow {
  id: string;
  content: string;
  category: string;
  type: string;
  vector: number[];
}

/** Loose shape of a `toArray()` result row for a cosine `vectorSearch` —
 *  narrowed from the library's `any[]` (see file header). Reads into local
 *  `const`s before narrowing (rather than repeated bracket access inside a
 *  compound `||` guard) so the control-flow narrowing is unambiguous. */
function readSearchRow(row: unknown): RetrievedPassage | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = r["id"];
  const content = r["content"];
  const rawDistance = r["_distance"];
  if (typeof id !== "string" || typeof content !== "string") return null;
  const distance = typeof rawDistance === "number" ? rawDistance : 0;
  return { id, content, score: clampScore(1 - distance) };
}

function clampScore(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * `GuidelineCorpus` implementation: LanceDB for `retrieve()` (embedded
 * `approved_messaging` passages), an in-memory pass-through for `rules()`
 * (the deterministic rule rows — lexicon/allowlist/denylist/tier_map — are
 * never embedded; they're consumed as structured data by `rules.ts`, not
 * retrieved by similarity).
 */
export class LanceCorpus implements GuidelineCorpus {
  private readonly embedder: Embedder;
  private readonly dbPath: string;
  private readonly tableName: string;
  private conn: Connection | null = null;
  private table: Table | null = null;
  private ruleRows: Guideline[] = [];

  constructor(opts: LanceCorpusOptions) {
    this.embedder = opts.embedder;
    this.dbPath = opts.dbPath;
    this.tableName = opts.tableName ?? DEFAULT_TABLE_NAME;
  }

  /**
   * Embeds every `type: "approved_messaging"` row's content and (re)writes
   * the LanceDB table in "overwrite" mode; keeps ALL rows (including the
   * non-embedded rule types) for `rules()`. Safe to call more than once
   * (e.g. re-seeding) — each call fully replaces both the table and the
   * in-memory rule set with the newly-ingested guidelines.
   */
  async ingest(guidelines: Guideline[]): Promise<void> {
    this.ruleRows = guidelines;
    const passages = guidelines.filter((g) => g.type === "approved_messaging");
    if (passages.length === 0) {
      // Nothing to embed this call. Deliberately leaves any table from a
      // PRIOR ingest() call alone (an empty follow-up ingest shouldn't wipe
      // a real corpus) -- and correctly leaves `this.table` at `null` if
      // this is the very first call, so `retrieve()` returns `[]`.
      return;
    }

    const vectors = await this.embedder.embed(passages.map((p) => p.content));
    const rows: PassageRow[] = passages.map((p, i) => ({
      id: p.id,
      content: p.content,
      category: p.category,
      type: p.type,
      vector: vectors[i] ?? [],
    }));

    const conn = await this.getConnection();
    this.table = await conn.createTable(this.tableName, rows, { mode: "overwrite" });
  }

  /** Top-k approved-messaging passages for "is this claim supported?"
   *  (seams.ts `GuidelineCorpus.retrieve`). Returns `[]` before the first
   *  successful `ingest()` of at least one `approved_messaging` row, rather
   *  than throwing — an empty corpus is a valid (if unhelpful) state. */
  async retrieve(query: string, k: number): Promise<RetrievedPassage[]> {
    if (!this.table || k <= 0) return [];
    const [vector] = await this.embedder.embed([query]);
    if (!vector) return [];

    const rows: unknown[] = await this.table.vectorSearch(vector).distanceType("cosine").limit(k).toArray();
    const passages: RetrievedPassage[] = [];
    for (const row of rows) {
      const passage = readSearchRow(row);
      if (passage) passages.push(passage);
    }
    return passages;
  }

  /** The deterministic rule rows (lexicon | allowlist | denylist | tier_map)
   *  — everything ingested EXCEPT the embedded approved_messaging passages
   *  (seams.ts `GuidelineCorpus.rules`). */
  async rules(): Promise<Guideline[]> {
    return this.ruleRows.filter((g) => g.type !== "approved_messaging");
  }

  /** Row count in the passages table — 0 before the first non-empty
   *  `ingest()`. Not part of the `GuidelineCorpus` seam; a small test/
   *  observability escape hatch (mirrors `MemoryRepo.query()`'s role). */
  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  private async getConnection(): Promise<Connection> {
    if (!this.conn) {
      this.conn = await lancedb.connect(this.dbPath);
    }
    return this.conn;
  }
}

/**
 * Convenience factory: defaults `embedder` to the real `HuggingFaceEmbedder`
 * when not supplied. The class constructor itself takes an already-resolved
 * `Embedder` with no default (the corpus layer's task spec: "the embedder
 * MUST be injectable") — this factory is the ergonomic entry point for real
 * usage, matching the `openMemory()` pattern in packages/memory (factory does
 * the sensible defaulting; the class stays fully explicit).
 */
export function createLanceCorpus(opts: { dbPath: string; embedder?: Embedder; tableName?: string }): LanceCorpus {
  return new LanceCorpus({
    dbPath: opts.dbPath,
    embedder: opts.embedder ?? new HuggingFaceEmbedder(),
    tableName: opts.tableName,
  });
}
