/**
 * Built-in tool factories used by the product agents. Each is a thin wrapper
 * over one of the @mstack/core adapter seams — the seam TYPES are imported, the
 * concrete provider is passed in by the caller. Handlers validate the model's
 * arguments with their own Zod schema (defaults applied), so a bad tool call
 * throws a ZodError that `runAgent` surfaces back to Claude as an error result.
 */
import { z } from "zod";
import type { EnrichmentProvider, GuidelineCorpus } from "@mstack/core";
import type { AgentTool } from "./types.js";

/** retrieve() — top-k approved-messaging passages for grounding a claim. */
export function retrieveTool(corpus: GuidelineCorpus): AgentTool {
  const inputSchema = z.object({
    query: z
      .string()
      .describe("the claim or question to find supporting passages for"),
    k: z
      .number()
      .int()
      .positive()
      .max(20)
      .default(5)
      .describe("how many passages to return"),
  });
  return {
    name: "retrieve",
    description:
      "Retrieve the top-k approved-messaging passages relevant to a claim or query. " +
      "Use it to check whether a claim is supported by approved messaging, and cite the returned passage id.",
    inputSchema,
    handler: async (args) => {
      const { query, k } = inputSchema.parse(args);
      return corpus.retrieve(query, k);
    },
  };
}

/** sqlQuery() — a read-only query against the compounding-memory warehouse. */
export function sqlQueryTool(
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>,
): AgentTool {
  const inputSchema = z.object({
    sql: z.string().describe("a single read-only SQL statement"),
    params: z
      .array(z.unknown())
      .optional()
      .describe("positional bind parameters, if the statement uses them"),
  });
  return {
    name: "sql_query",
    description:
      "Run a read-only SQL query against the account/signal warehouse and get the rows back. " +
      "Use it to pull an account's persisted signals or history. Never invent rows — only use what this returns.",
    inputSchema,
    handler: async (args) => {
      const { sql, params } = inputSchema.parse(args);
      return query(sql, params);
    },
  };
}

/** enrich() — resolve a company ref to a firmographic record with provenance. */
export function enrichTool(provider: EnrichmentProvider): AgentTool {
  const inputSchema = z.object({
    domain: z.string().describe("the company domain, e.g. figma.com"),
    name: z.string().optional().describe("optional company name hint"),
  });
  return {
    name: "enrich",
    description:
      "Resolve a company (by domain) to a firmographic record with per-field provenance. " +
      "Returns null if the provider has nothing. Resolve conflicting fields by provenance/trust, not by averaging.",
    inputSchema,
    handler: async (args) => {
      const { domain, name } = inputSchema.parse(args);
      return provider.enrich({ domain, name });
    },
  };
}
