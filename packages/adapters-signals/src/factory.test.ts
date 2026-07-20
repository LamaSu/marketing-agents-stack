import { describe, it, expect } from "vitest";

import { signalSource } from "./factory.js";
import { SampleSource } from "./sample-source.js";
import { SegmentWebhookSource } from "./segment-webhook-source.js";
import { PostHogSource } from "./posthog-source.js";
import { GitHubSignalSource } from "./github-source.js";
import { SqlWarehouseSource } from "./sql-warehouse-source.js";
import SampleSourceDefault from "./index.js";

describe("signalSource factory", () => {
  it('builds a SampleSource for "sample" (config optional)', () => {
    expect(signalSource("sample")).toBeInstanceOf(SampleSource);
  });

  it('builds a SegmentWebhookSource for "segment-webhook" (config optional)', () => {
    expect(signalSource("segment-webhook")).toBeInstanceOf(SegmentWebhookSource);
  });

  it('builds a PostHogSource for "posthog" given required config', () => {
    expect(signalSource("posthog", { projectId: "1" })).toBeInstanceOf(PostHogSource);
  });

  it('builds a GitHubSignalSource for "github" given required config', () => {
    expect(signalSource("github", { repos: [] })).toBeInstanceOf(GitHubSignalSource);
  });

  it('builds a SqlWarehouseSource for "sql-warehouse" given required config', () => {
    expect(signalSource("sql-warehouse", { query: async () => [] })).toBeInstanceOf(SqlWarehouseSource);
  });

  it("throws a clear error when a source requiring config gets none", () => {
    // Cast away the overloads' required-config typing to exercise the runtime guard directly
    // (a plain-JS caller, or one bypassing the types, could call it exactly this way).
    const call = signalSource as unknown as (name: string, config?: unknown) => unknown;
    expect(() => call("posthog")).toThrow(/config is required/);
  });
});

describe("package default export", () => {
  it("is SampleSource", () => {
    expect(SampleSourceDefault).toBe(SampleSource);
  });
});
