/**
 * @mstack/memory — recall.ts — an OPTIONAL semantic/temporal recall seam over
 * the warehouse, per research/10-sota-integration-design.md §2.8 (Wave C3).
 *
 * The swarm's context-pack builder sometimes wants "what do we already know
 * about this account?" as fuzzy/temporal recall, not an exact SQL pull. This
 * adds a thin `RecallProvider` seam for that, with an opt-in **Graphiti**
 * (Apache-2.0, getzep/graphiti — a bi-temporal knowledge graph) sidecar backing
 * it. Graphiti's philosophy fits an audit mindset: it *invalidates, never
 * deletes*.
 *
 * EDGE #3 — THE LINE THAT MUST NOT MOVE: the DuckDB warehouse + the hash-chained
 * `approvals` audit log (see `memory-repo.ts`) are the AUTHORITATIVE system of
 * record. Graphiti recall is a DERIVED, REBUILDABLE INDEX over that record —
 * NEVER a second source of truth. If the sidecar is absent, recall degrades to
 * NOTHING (the `noopRecallProvider` default returns `[]`) and correctness is
 * unaffected — a caller that gets `[]` simply falls back to warehouse SQL. No
 * decision, no send, no audit entry ever depends on a recall hit. Adopt the
 * Graphiti sidecar only when a real recall need appears; it is explicitly
 * optional.
 *
 * Same "opt-in sidecar behind an injectable seam, no-op offline default" shape
 * as `@mstack/reviewer`'s `nli-backstop.ts` and `adapters-enrichment`'s
 * `crawl4aiFetchSite`:
 *   - `noopRecallProvider` — the DEFAULT. Returns `[]`. Fully offline, zero
 *     network, zero config. The warehouse is the only thing consulted.
 *   - `createGraphitiRecall` / `graphitiRecall` — the OPT-IN real implementation,
 *     a Graphiti sidecar reached over plain HTTP (`docker/graphiti.md` has the
 *     run command). Graphiti is Python → separate process, never vendored into
 *     this strict-ESM TS tree (docs/build-conventions.md's sidecar rule).
 *
 * ASSUMPTION — VERIFY ON A LIVE SIDECAR (written without `pnpm install` or a
 * running Graphiti, per docs/build-conventions.md): the sidecar exposes
 *   POST {baseUrl}/search  { "accountId": <id>, "query": <string> }
 *   → { "hits": [ { "id", "text"|"fact"|"content", "score"|"similarity"?, "source"?, "ts"? } ] }
 * `extractHits` reads `hits` → `results` → `facts` (first array wins) and, per
 * hit, text from `text|fact|content` and score from `score|similarity` (else 0).
 * If a live Graphiti server's shape differs, widen `GraphitiSearchResponse` /
 * `extractHits` below — the `RecallProvider` seam, the no-op default, and every
 * caller are unaffected. Same documented-assumption discipline as `crawl4ai.ts`.
 */

/** One recalled fact about an account — a DERIVED index hit, never authoritative. */
export interface RecallHit {
  id: string;
  /** the recalled fact / passage text. */
  text: string;
  /** relevance/similarity, 0-1 (0 when the backend gives none). */
  score: number;
  /** where the fact was derived from, if the backend reports it. */
  source?: string;
  /** the fact's timestamp (Graphiti is bi-temporal), if reported. */
  ts?: string;
}

/** Semantic/temporal recall over the warehouse. Default impl returns `[]`. */
export interface RecallProvider {
  recall(accountId: string, query: string): Promise<RecallHit[]>;
}

/**
 * The DEFAULT implementation: no recall. Returns `[]`, fully offline, no sidecar,
 * no config. This is what keeps recall strictly optional — a caller that gets
 * `[]` falls back to warehouse SQL, and the keyless `mstack demo` needs nothing.
 */
export const noopRecallProvider: RecallProvider = {
  async recall(): Promise<RecallHit[]> {
    return [];
  },
};

export interface GraphitiRecallConfig {
  /** Graphiti sidecar base URL (trailing slash stripped). Defaults to the
   *  `GRAPHITI_URL` env var, then `http://localhost:8002`. */
  baseUrl?: string;
  /** injectable fetch — defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort + degrade after this many ms. Default 10000. */
  timeoutMs?: number;
  /** cap on hits returned to the caller. Default 10. */
  limit?: number;
}

const DEFAULT_BASE_URL = "http://localhost:8002";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 10;

interface GraphitiHitEntry {
  id?: string;
  text?: string;
  fact?: string;
  content?: string;
  score?: number;
  similarity?: number;
  source?: string;
  ts?: string;
}
interface GraphitiSearchResponse {
  hits?: GraphitiHitEntry[];
  results?: GraphitiHitEntry[];
  facts?: GraphitiHitEntry[];
}

function firstArray(json: GraphitiSearchResponse): GraphitiHitEntry[] {
  return json.hits ?? json.results ?? json.facts ?? [];
}

function toHit(entry: GraphitiHitEntry, index: number): RecallHit {
  const text = entry.text ?? entry.fact ?? entry.content ?? "";
  const score = typeof entry.score === "number" ? entry.score : typeof entry.similarity === "number" ? entry.similarity : 0;
  return {
    id: entry.id ?? `recall_${index}`,
    text,
    score,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
  };
}

/**
 * Build a `RecallProvider` backed by a Graphiti sidecar. On ANY failure (sidecar
 * unreachable, non-OK status, timeout, malformed response) it returns `[]` — the
 * SAME thing `noopRecallProvider` returns — and warns. Degraded to "no recall,"
 * never a crash, never a spurious hit from a flaky sidecar. Matches
 * `createHhemBackstop` / `createCrawl4aiFetchSite` degradation exactly. Hits with
 * empty text are dropped; the result is truncated to `limit`.
 */
export function createGraphitiRecall(config: GraphitiRecallConfig = {}): RecallProvider {
  const baseUrl = (config.baseUrl ?? process.env["GRAPHITI_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = config.limit ?? DEFAULT_LIMIT;

  return {
    async recall(accountId: string, query: string): Promise<RecallHit[]> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, query }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`graphiti sidecar at ${baseUrl} responded ${res.status}`);
        }
        const json = (await res.json()) as GraphitiSearchResponse;
        return firstArray(json)
          .map(toHit)
          .filter((h) => h.text.trim() !== "")
          .slice(0, limit);
      } catch (err) {
        console.warn(
          `[@mstack/memory] graphitiRecall: sidecar at ${baseUrl} failed for account "${accountId}" ` +
            `(${String(err)}); returning [] — recall is optional, the warehouse stays authoritative (degraded, not broken)`,
        );
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Ready-to-use default instance — `GRAPHITI_URL` env (or `http://localhost:8002`)
 * + global fetch. For tests, use `createGraphitiRecall({ fetchImpl })` so nothing
 * touches the real network — or hand-write a fake `RecallProvider`.
 */
export const graphitiRecall: RecallProvider = createGraphitiRecall();
