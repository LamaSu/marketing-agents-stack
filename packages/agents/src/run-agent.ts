/**
 * runAgent — the one call every product agent makes (architecture §3.0).
 *
 * Assembles the system prompt + labeled context-pack + JSON input into a
 * Messages API call, runs the Claude tool-use loop, then coerces the final
 * assistant text to JSON and validates it with `outSchema`. On a parse/validation
 * failure it performs EXACTLY ONE bounded re-ask (feeding the Zod error back),
 * then returns the validated output or throws `AgentOutputError`.
 *
 * The Anthropic client is injectable, so the whole loop runs offline in tests.
 * No LangChain — just the Anthropic SDK + Zod.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { resolveClient } from "./client.js";
import { contextPack } from "./context-pack.js";
import { toInputSchema } from "./json-schema.js";
import type { AgentTool, RunAgentConfig } from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_ITERATIONS = 8;

/** Thrown when the agent output fails schema validation even after the re-ask. */
export class AgentOutputError extends Error {
  readonly rawOutput: string;
  constructor(message: string, rawOutput: string) {
    super(message);
    this.name = "AgentOutputError";
    this.rawOutput = rawOutput;
  }
}

export async function runAgent<TIn, TOut>(
  cfg: RunAgentConfig<TIn, TOut>,
): Promise<TOut> {
  const client = resolveClient(cfg.client);
  const tools = cfg.tools ?? [];
  const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = cfg.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toInputSchema(t.inputSchema) as Anthropic.Tool.InputSchema,
  }));
  const toolByName = new Map<string, AgentTool>(tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildInitialUserContent(cfg) },
  ];

  // ── tool-use loop ────────────────────────────────────────────────────
  let finalText = "";
  for (let i = 0; i < maxIterations; i++) {
    const resp = await client.messages.create(
      request(cfg.model, maxTokens, cfg.system, messages, toolDefs),
    );
    // Preserve the full assistant turn (keeps tool_use blocks for the next turn).
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === "tool_use") {
          results.push(await runToolSafely(toolByName.get(block.name), block));
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    finalText = extractText(resp);
    break;
  }

  // ── coerce + validate, with EXACTLY ONE bounded re-ask ───────────────
  const first = tryParse(cfg.outSchema, finalText);
  if (first.ok) return first.value;

  messages.push({
    role: "user",
    content:
      "Your previous response did not match the required JSON output schema. " +
      `The validation error was:\n${first.error}\n\n` +
      "Return the corrected JSON object only — it must satisfy the schema. " +
      "No prose, no explanation, no markdown code fences.",
  });

  const reask = await client.messages.create(
    // No tools on the re-ask: we want a final JSON answer, not another tool call.
    request(cfg.model, maxTokens, cfg.system, messages, []),
  );
  const reaskText = extractText(reask);
  const second = tryParse(cfg.outSchema, reaskText);
  if (second.ok) return second.value;

  throw new AgentOutputError(
    `Agent output failed schema validation after one re-ask: ${second.error}`,
    reaskText,
  );
}

/* ───────────────────────────── helpers ─────────────────────────────── */

function request(
  model: string,
  maxTokens: number,
  system: string,
  messages: Anthropic.MessageParam[],
  toolDefs: Anthropic.Tool[],
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (toolDefs.length > 0) params.tools = toolDefs;
  return params;
}

function buildInitialUserContent<TIn, TOut>(
  cfg: RunAgentConfig<TIn, TOut>,
): string {
  const parts: string[] = [];
  if (cfg.contextPack && cfg.contextPack.length > 0) {
    parts.push(contextPack(cfg.contextPack));
  }
  parts.push(`INPUT (JSON):\n${JSON.stringify(cfg.input, null, 2)}`);
  parts.push(
    "Respond with only a JSON object matching the required output schema. " +
      "No prose, no markdown code fences.",
  );
  return parts.join("\n\n");
}

function extractText(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function runToolSafely(
  tool: AgentTool | undefined,
  block: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  if (!tool) {
    return errorResult(block.id, `Unknown tool: ${block.name}`);
  }
  try {
    const result = await tool.handler(block.input);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: typeof result === "string" ? result : JSON.stringify(result),
    };
  } catch (err) {
    return errorResult(block.id, `Tool "${tool.name}" failed: ${errMsg(err)}`);
  }
}

function errorResult(
  toolUseId: string,
  content: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: true,
  };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function tryParse<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  const cleaned = stripJsonFences(text).trim();
  if (cleaned.length === 0) {
    return { ok: false, error: "empty response (no JSON produced)" };
  }
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: `not valid JSON (${errMsg(err)}). received: ${truncate(cleaned)}`,
    };
  }
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: formatZodError(parsed.error) };
}

function stripJsonFences(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fenced && fenced[1] !== undefined) return fenced[1];
  return t;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
