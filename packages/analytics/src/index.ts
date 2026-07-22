/**
 * @mstack/analytics — deterministic, offline funnel + conversion reporting over the
 * `MemoryRepo` warehouse: the funnel/dashboard layer every incumbent (MadKudu, Outreach,
 * Clearbit) ships as its core reporting surface. Read-only, no network, no LLM call —
 * see `report.ts` for the exact funnel definition, table/column provenance, and the
 * three report functions (`funnelReport`, `conversionByTier`, `reviewOutcomes`) plus
 * the `formatReport` text renderer a future `mstack report` CLI command can call as-is.
 */
export * from "./report.js";
