/**
 * LlmWebProvider — the open replacement for a paid enrichment vendor
 * (research/tools/B-enrichment-data.md §10; validated live in the transcript per
 * research/06-architecture.md: "Rajan beat a paid tool with a Claude skill"). Flow:
 * domain -> fetch site text (INJECTABLE `fetchSite`, defaults to a plain `fetch` +
 * basic HTML strip) -> Claude extracts a typed `EnrichmentRecord` against a zod
 * schema via tool-use structured output.
 *
 * Both the fetcher and the Claude client are constructor-injected so this package's
 * own tests run fully offline (docs/build-conventions.md): no real network call, no
 * real API key, ever, in this package's test suite. There is deliberately NO default
 * client — unlike `fetchSite`, there's no sane offline default for "call a paid-tier
 * LLM"; `client` is a required config field.
 *
 * Crawl4AI (OSS, Apache-2.0, unclecode/crawl4ai) is the documented opt-in
 * higher-quality fetcher — pass a `fetchSite` that calls out to a local Crawl4AI
 * service instead of the default plain-fetch+strip-tags fetcher for materially better
 * extraction (JS-rendered pages, main-content isolation). Wiring an actual Crawl4AI
 * HTTP client is left to the caller/a later wave; this module only defines the seam
 * (`FetchSite`) it plugs into.
 *
 * ASSUMPTION (verify on the Spark build — this package was written without running
 * `pnpm install` locally): `client` is typed against a minimal hand-declared
 * `ClaudeMessagesClient` interface below (`messages.create({...}) -> {content:[...]}`),
 * NOT an import of `@anthropic-ai/sdk`'s own exported types — this offline session
 * could not verify the SDK's exact nested type-export names/required-field shapes
 * against an installed copy. A real `new Anthropic({ apiKey })` instance from
 * `@anthropic-ai/sdk` (declared as this package's dependency) satisfies
 * `ClaudeMessagesClient` structurally (duck typing) for the `messages.create` call
 * this provider makes. If a real call-shape mismatch surfaces at Spark
 * install/typecheck time, widen `ClaudeMessageParams`/`ClaudeMessageResult` below —
 * the provider's extraction logic itself does not change.
 */
import { z } from "zod";
import type { EnrichmentProvider, EnrichmentRecord, Firmographic } from "@mstack/core";

export type FetchSite = (url: string) => Promise<string>;

/**
 * Default fetchSite: plain `fetch` + a crude tag-stripper. Good enough to hand Claude
 * readable text; swap for a Crawl4AI-backed fetcher in production for materially
 * cleaner extraction. Never called by the offline demo path — `llm-web` is opt-in
 * (research/06-architecture.md §5.1).
 */
export const defaultFetchSite: FetchSite = async (url: string): Promise<string> => {
  const res = await fetch(url, { headers: { "User-Agent": "marketing-agents-stack/0.1" } });
  if (!res.ok) throw new Error(`fetchSite: ${url} responded ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000); // keep the extraction prompt bounded
};

/** What Claude's structured output is validated against — a strict subset of
 *  EnrichmentRecord's fields; `domain`/`source`/`provenance` are filled in by this
 *  provider, not asked of the model. */
const LlmExtraction = z.object({
  name: z.string().nullable(),
  employees: z.number().int().nullable(),
  industry: z.string().nullable(),
  region: z.string().nullable(),
  tech: z.array(z.string()).default([]),
});
type LlmExtraction = z.infer<typeof LlmExtraction>;

const EXTRACTION_TOOL_NAME = "emit_enrichment_record";

/** The minimal shape this provider needs from a Claude client — see the file-header
 *  ASSUMPTION note on why this isn't imported from `@anthropic-ai/sdk` directly. */
export interface ClaudeMessagesClient {
  messages: {
    create(params: ClaudeMessageParams): Promise<ClaudeMessageResult>;
  };
}
export interface ClaudeMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: unknown[];
  tool_choice?: unknown;
}
export interface ClaudeToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}
export type ClaudeContentBlock = ClaudeToolUseBlock | { type: string; [key: string]: unknown };
export interface ClaudeMessageResult {
  content: ClaudeContentBlock[];
}

function isToolUseBlock(block: ClaudeContentBlock): block is ClaudeToolUseBlock {
  return block.type === "tool_use";
}

export interface LlmWebProviderConfig {
  /** injectable Claude client — required; tests pass a fake with a canned `messages.create`. */
  client: ClaudeMessagesClient;
  /** injectable site fetcher — defaults to plain fetch + tag-strip. Pass a Crawl4AI-backed fetcher for production quality. */
  fetchSite?: FetchSite;
  model?: string;
}

export class LlmWebProvider implements EnrichmentProvider {
  readonly name = "llm-web";
  readonly #client: ClaudeMessagesClient;
  readonly #fetchSite: FetchSite;
  readonly #model: string;

  constructor(config: LlmWebProviderConfig) {
    this.#client = config.client;
    this.#fetchSite = config.fetchSite ?? defaultFetchSite;
    this.#model = config.model ?? "claude-sonnet-5";
  }

  async enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null> {
    const domain = ref.domain.trim().toLowerCase();

    let siteText: string;
    try {
      siteText = await this.#fetchSite(`https://${domain}`);
    } catch {
      return null; // unreachable site -- not this provider's job to retry/backoff
    }
    if (!siteText.trim()) return null;

    const extracted = await this.#extract(domain, ref.name, siteText);
    if (!extracted) return null;

    const firmographic: Firmographic = { tech: extracted.tech };
    const provenance: Record<string, string> = {};
    if (extracted.employees !== null) {
      firmographic.employees = extracted.employees;
      provenance.employees = this.name;
    }
    if (extracted.industry !== null) {
      firmographic.industry = extracted.industry;
      provenance.industry = this.name;
    }
    if (extracted.region !== null) {
      firmographic.region = extracted.region;
      provenance.region = this.name;
    }
    if (extracted.tech.length > 0) provenance.tech = this.name;

    const record: EnrichmentRecord = { domain, firmographic, provenance, source: this.name };
    if (extracted.name !== null) {
      record.name = extracted.name;
      provenance.name = this.name;
    }
    return record;
  }

  async #extract(domain: string, name: string | undefined, siteText: string): Promise<LlmExtraction | null> {
    const result = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 1024,
      system:
        "You extract company firmographic facts from raw website text. You do not guess or " +
        "invent facts not evidenced in the text -- return null for any field you cannot support. " +
        "Call the emit_enrichment_record tool exactly once with your best extraction.",
      messages: [
        {
          role: "user",
          content: `Domain: ${domain}\nKnown name: ${name ?? "(unknown)"}\n\nSite text:\n${siteText}`,
        },
      ],
      tools: [
        {
          name: EXTRACTION_TOOL_NAME,
          description: "Emit the extracted firmographic record.",
          input_schema: {
            type: "object",
            properties: {
              name: { type: ["string", "null"] },
              employees: { type: ["integer", "null"] },
              industry: { type: ["string", "null"] },
              region: { type: ["string", "null"] },
              tech: { type: "array", items: { type: "string" } },
            },
            required: ["name", "employees", "industry", "region", "tech"],
          },
        },
      ],
      tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
    });

    const toolUse = result.content.find(isToolUseBlock);
    if (!toolUse) return null;

    // One bounded attempt -- no re-ask loop at this seam-level provider. A re-ask
    // loop on zod parse failure is `packages/agents`' `runAgent` mechanism
    // (research/06-architecture.md §3.0); this provider is a plain adapter, not an
    // agent, so it stays a single attempt and returns null on a bad extraction.
    const parsed = LlmExtraction.safeParse(toolUse.input);
    return parsed.success ? parsed.data : null;
  }
}
