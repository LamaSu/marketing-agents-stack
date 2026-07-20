/**
 * @mstack/credentials -- the credential-broker boundary. Provider keys never enter agent or
 * adapter context: this package is the only place a raw secret is read, and only
 * `LocalBroker` (env vars) or `GatecraftBroker` (opt-in gatecraft MCP) ever see one.
 * See research/06-architecture.md §3.3 + §5.1.
 */
export * from "./types.js";
export * from "./util.js";
export * from "./registry.js";
export * from "./local-broker.js";
export * from "./gatecraft-broker.js";
export * from "./factory.js";
