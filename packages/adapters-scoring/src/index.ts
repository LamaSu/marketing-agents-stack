/** @mstack/adapters-scoring -- ScoringProvider implementations: Rules (default floor),
 *  Claude (cold-start), Onnx (optional ML), Hybrid (default composite). See
 *  research/06-architecture.md §3.2 + §5.1 and research/tools/D-warehouse-scoring.md. */
export * from "./tiers.js";
export * from "./rules-scorer.js";
export * from "./claude-scorer.js";
export * from "./onnx-scorer.js";
export * from "./hybrid-scorer.js";
export * from "./factory.js";
