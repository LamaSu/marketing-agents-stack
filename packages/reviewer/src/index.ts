/**
 * @mstack/reviewer — corpus + deterministic-rule layer for the Asset-Review /
 * Claim-Drift agent (research/06-architecture.md §3.1, §7 W2-T4).
 *
 * This package covers the RAG corpus (`LanceCorpus`, embedding-agnostic via
 * the injectable `Embedder` seam) and the mechanical, model-independent
 * pre-scan (`scanDeterministic`). It deliberately stops there:
 *
 * TODO(wave3): the Claude agent pipeline (extract -> retrieve -> judge ->
 * score, research/06-architecture.md §3.1 pipeline steps 3/5/6, built in
 * `packages/agents` + `packages/reviewer`'s agent-facing module) plugs in on
 * top of the two exports below —
 *   - `scanDeterministic()`'s `FindingDraft[]` become high-confidence priors
 *     the Claude judge (Opus) merges in.
 *   - `LanceCorpus.retrieve()` is what the judge calls per check-worthy claim
 *     to find (or fail to find) supporting evidence.
 * No agent-calling code (Anthropic SDK, prompts, Zod-reask loop) lives here.
 */
export * from "./embedder.js";
export * from "./lance-corpus.js";
export * from "./rules.js";
export * from "./corpus-loader.js";
