/**
 * @mstack/adapters-signals -- SignalSource implementations behind @mstack/core's seam:
 * SampleSource (default, offline), SegmentWebhookSource, PostHogSource, GitHubSignalSource,
 * SqlWarehouseSource, plus the signalSource(name, config) factory. See
 * research/06-architecture.md §5.1 and research/tools/A-signals-ingestion.md.
 */
export * from "./sample-source.js";
export * from "./segment-webhook-source.js";
export * from "./posthog-source.js";
export * from "./github-source.js";
export * from "./sql-warehouse-source.js";
export * from "./factory.js";
export * from "./util.js";

export { SampleSource as default } from "./sample-source.js";
