/** @mstack/adapters-outreach — Composio behind the `OutreachChannel` seam
 *  (research/10-sota-integration-design.md §2.3, Wave C1). A `ComposioChannel`
 *  gets Composio's 1000+ app send reach, but ONLY through the same gated,
 *  approval-asserting dispatch every channel uses — guardrail #2 is a type on
 *  the seam, so Composio structurally cannot bypass it. The SDK is loaded lazily
 *  (opt-in); nothing here is on the offline `mstack demo` path. */
export * from "./composio-channel.js";
