/** @mstack/adapters-crm — CrmSync seam implementations: push OUR derived
 *  scores/decisions/outcomes back into Salesforce/HubSpot/etc. Offline
 *  default is `noopCrmSync` (does nothing); `createHttpCrmSync` and
 *  `createComposioCrmSync` are opt-in, degrade-safe pushers. See README.md. */
export * from "./crm-sync.js";
export * from "./http-crm-sync.js";
export * from "./composio-crm-sync.js";
