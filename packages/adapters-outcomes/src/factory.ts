/**
 * outcomeSource(name, config) -- the one place that knows about every OutcomeSource
 * implementation in this package, so callers (the runtime layer, chorus workflows, cli)
 * register outcome sources by name + config instead of importing every class directly.
 * Mirrors adapters-signals' `signalSource(name, config)` factory, for the return leg.
 */
import type { OutcomeSource } from "./outcome-source.js";
import { SampleOutcomeSource, type SampleOutcomeSourceConfig } from "./sample-outcome-source.js";
import { WebhookOutcomeSource, type WebhookOutcomeSourceConfig } from "./webhook-outcome-source.js";
import { HttpOutcomeSource, type HttpOutcomeSourceConfig } from "./http-outcome-source.js";

export type OutcomeSourceName = "sample" | "webhook" | "http";

function requireConfig(name: string, config: unknown): unknown {
  if (config === undefined) {
    throw new Error(`outcomeSource("${name}", config): config is required for this source`);
  }
  return config;
}

export function outcomeSource(name: "sample", config?: SampleOutcomeSourceConfig): SampleOutcomeSource;
export function outcomeSource(name: "webhook", config?: WebhookOutcomeSourceConfig): WebhookOutcomeSource;
export function outcomeSource(name: "http", config: HttpOutcomeSourceConfig): HttpOutcomeSource;
export function outcomeSource(name: OutcomeSourceName, config?: unknown): OutcomeSource {
  switch (name) {
    case "sample":
      return new SampleOutcomeSource(config as SampleOutcomeSourceConfig | undefined);
    case "webhook":
      return new WebhookOutcomeSource(config as WebhookOutcomeSourceConfig | undefined);
    case "http":
      return new HttpOutcomeSource(requireConfig(name, config) as HttpOutcomeSourceConfig);
    default: {
      const exhaustive: never = name;
      throw new Error(`outcomeSource: unknown source name "${String(exhaustive)}"`);
    }
  }
}
