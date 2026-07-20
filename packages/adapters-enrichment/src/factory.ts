/**
 * enrichmentProvider(name, config?) — construct an `EnrichmentProvider` by name.
 * Default (no args) is the offline `SampleProvider`, per research/06-architecture.md
 * §5.1: "Enrichment | EnrichmentProvider | sample fixtures | enable llm-web ... +
 * keyless wikidata/gleif/edgar/techdetect/email".
 */
import type { EnrichmentProvider } from "@mstack/core";
import { SampleProvider, type SampleProviderConfig } from "./sample.js";
import { LlmWebProvider, type LlmWebProviderConfig } from "./llm-web.js";
import { WikidataProvider, GleifProvider, EdgarProvider, type RegistryProviderConfig } from "./registries.js";

export type EnrichmentProviderName = "sample" | "llm-web" | "wikidata" | "gleif" | "edgar";
export type EnrichmentProviderConfig = SampleProviderConfig | LlmWebProviderConfig | RegistryProviderConfig;

export function enrichmentProvider(
  name: EnrichmentProviderName = "sample",
  config?: EnrichmentProviderConfig,
): EnrichmentProvider {
  switch (name) {
    case "sample":
      return new SampleProvider(config as SampleProviderConfig | undefined);
    case "llm-web": {
      const llmConfig = config as LlmWebProviderConfig | undefined;
      if (!llmConfig?.client) {
        throw new Error(
          'enrichmentProvider("llm-web", config): config.client (a Claude messages client) is required -- ' +
            "there is no offline default for the LLM-web provider (research/06-architecture.md §5.1).",
        );
      }
      return new LlmWebProvider(llmConfig);
    }
    case "wikidata":
      return new WikidataProvider(config as RegistryProviderConfig | undefined);
    case "gleif":
      return new GleifProvider(config as RegistryProviderConfig | undefined);
    case "edgar":
      return new EdgarProvider(config as RegistryProviderConfig | undefined);
    default: {
      const exhaustive: never = name;
      throw new Error(`enrichmentProvider: unknown provider name "${String(exhaustive)}"`);
    }
  }
}
