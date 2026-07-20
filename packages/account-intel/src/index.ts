/**
 * @mstack/account-intel -- the Account-Intelligence engine + agent swarm
 * (research/06-architecture.md §3.2, §7 W3-T3). Context engine
 * (`resolveAccount`) -> scoring noise filter (`rankAccounts`) -> the swarm
 * (SDR-Researcher -> Copywriter -> GTM-Router) -> `activateAccount`, the
 * single orchestrating entry point. Draft-first, mechanically: nothing in
 * this package ever dispatches (see `activate-account.ts`'s file header).
 */
export * from "./context-engine.js";
export * from "./ranking.js";
export * from "./sdr-researcher.js";
export * from "./copywriter.js";
export * from "./gtm-router.js";
export * from "./policy.js";
export * from "./activate-account.js";
