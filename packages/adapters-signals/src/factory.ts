/**
 * signalSource(name, config) -- the one place that knows about every SignalSource
 * implementation in this package, so callers (the runtime layer, chorus workflows, cli)
 * register sources by name + config instead of importing every class directly. See
 * research/06-architecture.md §5.1 ("register PostHogSource (key), GitHubSignalSource (PAT),
 * point Jitsu/RudderStack/Segment at the SegmentWebhookSource endpoint, or SqlWarehouseSource").
 */
import type { SignalSource } from "@mstack/core";

import { SampleSource, type SampleSourceConfig } from "./sample-source.js";
import { SegmentWebhookSource, type SegmentWebhookSourceConfig } from "./segment-webhook-source.js";
import { PostHogSource, type PostHogSourceConfig } from "./posthog-source.js";
import { GitHubSignalSource, type GitHubSignalSourceConfig } from "./github-source.js";
import { SqlWarehouseSource, type SqlWarehouseSourceConfig } from "./sql-warehouse-source.js";

export type SignalSourceName = "sample" | "segment-webhook" | "posthog" | "github" | "sql-warehouse";

function requireConfig(name: string, config: unknown): unknown {
  if (config === undefined) {
    throw new Error(`signalSource("${name}", config): config is required for this source`);
  }
  return config;
}

export function signalSource(name: "sample", config?: SampleSourceConfig): SampleSource;
export function signalSource(name: "segment-webhook", config?: SegmentWebhookSourceConfig): SegmentWebhookSource;
export function signalSource(name: "posthog", config: PostHogSourceConfig): PostHogSource;
export function signalSource(name: "github", config: GitHubSignalSourceConfig): GitHubSignalSource;
export function signalSource(name: "sql-warehouse", config: SqlWarehouseSourceConfig): SqlWarehouseSource;
export function signalSource(name: SignalSourceName, config?: unknown): SignalSource {
  switch (name) {
    case "sample":
      return new SampleSource(config as SampleSourceConfig | undefined);
    case "segment-webhook":
      return new SegmentWebhookSource(config as SegmentWebhookSourceConfig | undefined);
    case "posthog":
      return new PostHogSource(requireConfig(name, config) as PostHogSourceConfig);
    case "github":
      return new GitHubSignalSource(requireConfig(name, config) as GitHubSignalSourceConfig);
    case "sql-warehouse":
      return new SqlWarehouseSource(requireConfig(name, config) as SqlWarehouseSourceConfig);
    default: {
      const exhaustive: never = name;
      throw new Error(`signalSource: unknown source name "${String(exhaustive)}"`);
    }
  }
}
