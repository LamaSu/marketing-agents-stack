/** Zod → JSON Schema for Claude tool definitions. */
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Convert a Zod schema to a JSON-Schema object suitable for an Anthropic tool
 * `input_schema`. Refs are inlined (`$refStrategy: "none"`) because Claude tool
 * schemas should be self-contained, and the `$schema` marker is stripped.
 */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete json["$schema"];
  return json;
}
