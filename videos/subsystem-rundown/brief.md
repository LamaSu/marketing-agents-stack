# subsystem-rundown — storyboard

**Takeaway:** a package-by-package tour of how the stack actually works — real module
names, real transforms, in pipeline order.

**Pattern:** module-map / call-walkthrough. Dark palette, mono for code names. ~2 min.

## Beats (each = one package, its real mechanism)
0. Title.
1. **@mstack/core** — 10 Zod schemas + 5 adapter seams; the shared vocabulary.
2. **@mstack/adapters-signals** — raw event → SampleSource/Segment/PostHog/GitHub → one `Signal`.
3. **@mstack/memory** — DuckDB (one table/primitive) + the hash-chained approval audit (`sha256(prevHash+data)`).
4. **@mstack/adapters-enrichment** — domain → sample / llm-web (Crawl4AI+Claude) / Wikidata·GLEIF·EDGAR → `mergeEnrichment` (trust order + provenance).
5. **@mstack/adapters-scoring** — Rules + Claude + ONNX → `HybridScorer` → 76/100 (disqualifier = hard floor).
6. **@mstack/agents** — `runAgent<In,Out>`: system+context-pack → Messages API + tool-use loop → Zod-validate → 1 re-ask. No LangChain.
7. **@mstack/reviewer** — the 6-step claim-drift pipeline (segment → scanDeterministic → extract → LanceCorpus.retrieve → judge → scoreForChanges) — never writes copy.
8. **@mstack/account-intel** — resolveAccount → rankAccounts → swarm (SDR→Copywriter→GTM-Router) → Decision + pending Draft.
9. **@mstack/credentials** — gatecraft broker: provider gets `proxyCall()` only, never the key.
10. **@mstack/runtime** — draft-first state machine pending→approved→dispatched; `assertDispatchable` verifies persisted draft + hash-chained Approval; `dispatch.ts` is the one send path.
11. **apps/** — mstack CLI + Portal + Console; offline vs live.
12. Close — swap any sample→real behind a seam; 12 packages, ~280 tests, offline.
