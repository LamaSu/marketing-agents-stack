# Graphiti sidecar (opt-in, for the `RecallProvider` seam)

`@mstack/memory`'s `graphitiRecall` talks to a **Graphiti** HTTP sidecar —
never a vendored dependency (Python tool → separate process, per
`docs/build-conventions.md`). It is **opt-in**: the default `noopRecallProvider`
returns `[]`, so the keyless `mstack demo` never needs this. Graphiti is
**Apache-2.0** (getzep/graphiti).

## The line that must not move (edge #3)

Graphiti recall is a **derived, rebuildable index** over the warehouse — **never
a second source of truth**. The DuckDB warehouse + the hash-chained `approvals`
audit log stay authoritative. If this sidecar is absent, recall returns `[]` and
callers fall back to warehouse SQL; no decision, send, or audit entry ever
depends on a recall hit.

## Run it

Graphiti needs a graph backend (Neo4j or FalkorDB) plus an LLM key for indexing.
You also need a thin HTTP wrapper exposing `POST /search` over `graphiti.search(...)`
(Graphiti ships as a library; getzep also publishes a REST server image —
`graphiti-server` — whose search route you can map to the contract below):

```bash
# example shape — see getzep/graphiti for the current server image + env
docker run -d --name graphiti -p 8002:8000 \
  -e OPENAI_API_KEY=sk-... \
  -e NEO4J_URI=bolt://neo4j:7687 -e NEO4J_USER=neo4j -e NEO4J_PASSWORD=... \
  zepai/graphiti

export GRAPHITI_URL=http://localhost:8002
```

Then index the warehouse's signals/decisions into Graphiti out-of-band (a batch
job that reads the DuckDB warehouse and `add_episode`s into Graphiti). Because
recall is a derived index, this can be rebuilt from the warehouse at any time.

## Contract the seam assumes

`POST {GRAPHITI_URL}/search`

```jsonc
// request
{ "accountId": "<id>", "query": "<what to recall>" }

// response (keys vary — the seam reads the first array that fits)
{ "hits": [ { "id": "h1", "text": "…fact…", "score": 0.9, "source": "crm", "ts": "2026-04-01" } ] }
//   array ← hits | results | facts
//   text  ← text | fact | content
//   score ← score | similarity | 0
```

**Assumption, verify on a live server.** Written without standing up Graphiti
(per `docs/build-conventions.md`). If the live shape differs, widen
`GraphitiSearchResponse` / `extractHits` in `packages/memory/src/recall.ts` — the
`RecallProvider` seam, the no-op default, and every caller are unaffected. On ANY
failure the seam returns `[]` (degraded); it never throws or blocks.

See `research/10-sota-integration-design.md` §2.8 (Wave C3).
