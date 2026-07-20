/**
 * @mstack/reviewer — corpus + deterministic-rule layer for the Asset-Review /
 * Claim-Drift agent (research/06-architecture.md §3.1, §7 W2-T4).
 *
 * This package covers the RAG corpus (`LanceCorpus`, embedding-agnostic via
 * the injectable `Embedder` seam) and the mechanical, model-independent
 * pre-scan (`scanDeterministic`). It deliberately stops there:
 *
 * The Claude agent pipeline (extract -> retrieve -> judge -> score,
 * research/06-architecture.md §3.1 pipeline steps 3/5/6) lives in
 * `review-agent.ts`, built ON `packages/agents`' `runAgent` mechanism:
 *   - `scanDeterministic()`'s `FindingDraft[]` become high-confidence priors
 *     the Claude judge (Opus) merges in.
 *   - `LanceCorpus.retrieve()` is what the pipeline calls per check-worthy
 *     claim to find (or fail to find) supporting evidence.
 * The corpus + rule layer below is agent-agnostic (no Anthropic SDK); the
 * agent code is isolated in `review-agent.ts` so the corpus layer can be used
 * (and tested) without a Claude key.
 */
export * from "./embedder.js";
export * from "./lance-corpus.js";
export * from "./rules.js";
export * from "./corpus-loader.js";
export * from "./review-agent.js";
