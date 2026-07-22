import { describe, it, expect } from "vitest";

import { outcomeSource } from "./factory.js";
import { SampleOutcomeSource } from "./sample-outcome-source.js";
import { WebhookOutcomeSource } from "./webhook-outcome-source.js";
import { HttpOutcomeSource } from "./http-outcome-source.js";

describe("outcomeSource factory", () => {
  it('builds a SampleOutcomeSource for "sample" (config optional)', () => {
    expect(outcomeSource("sample")).toBeInstanceOf(SampleOutcomeSource);
  });

  it('builds a WebhookOutcomeSource for "webhook" (config optional)', () => {
    expect(outcomeSource("webhook")).toBeInstanceOf(WebhookOutcomeSource);
  });

  it('builds an HttpOutcomeSource for "http" given required config', () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ events: [] }));
    expect(outcomeSource("http", { endpoint: "https://x.example.com", fetchImpl })).toBeInstanceOf(HttpOutcomeSource);
  });

  it("throws a clear error when a source requiring config gets none", () => {
    // Cast away the overloads' required-config typing to exercise the runtime guard directly
    // (a plain-JS caller, or one bypassing the types, could call it exactly this way).
    const call = outcomeSource as unknown as (name: string, config?: unknown) => unknown;
    expect(() => call("http")).toThrow(/config is required/);
  });

  it("throws a clear error for an unknown source name", () => {
    const call = outcomeSource as unknown as (name: string, config?: unknown) => unknown;
    expect(() => call("carrier-pigeon")).toThrow(/unknown source name/);
  });
});
