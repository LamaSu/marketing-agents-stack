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
 *
 * OpenTelemetry tracing (research/10-sota-integration-design.md §2.1, Wave B1):
 * every model call and tool execution wraps in a span via a tracer obtained
 * from `trace.getTracer(...)`. That call returns the OTel NO-OP TRACER when no
 * TracerProvider is registered — the default for the keyless demo — so every
 * `span.*` call below is a free no-op and nothing needs a collector. A
 * deployer opts in by registering a real TracerProvider (any OTLP-compatible
 * backend) before this module's spans run; `@opentelemetry/api`'s proxy
 * mechanism means that registration can happen after this module is imported.
 * Streaming is the other opt-in here: `cfg.stream` is undefined by default, so
 * the loop keeps calling the non-streaming `client.messages.create` exactly as
 * before.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { z } from "zod";
import { resolveClient } from "./client.js";
import { contextPack } from "./context-pack.js";
import { toInputSchema } from "./json-schema.js";
import type { AgentTool, AnthropicClient, RunAgentConfig } from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_ITERATIONS = 8;

/** The package tracer, resolved LAZILY per call (not cached at module load).
 *  Resolves to the OTel no-op tracer until a deployer registers a real
 *  TracerProvider — every span created through it is then a free no-op, which
 *  is what keeps the keyless demo collector-free. Acquiring it per-call (rather
 *  than one module-level const) is deliberate: a module-load `getTracer()`
 *  returns a ProxyTracer that caches its delegate on first resolution and never
 *  re-resolves, so a provider registered (or re-registered) after import would
 *  be ignored. Lazy acquisition makes "register a provider after import" — and
 *  the test suite's disable/re-register cycle — actually work. */
function tracer() {
  return trace.getTracer("@mstack/agents");
}

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
  return tracer().startActiveSpan("agents.runAgent", async (span) => {
    span.setAttribute("model", cfg.model);
    span.setAttribute("prompt_hash", promptHash(cfg));
    try {
      const out = await runLoop(cfg, span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * The tool-use loop + bounded re-ask — unchanged from the pre-tracing version
 * except each model call now routes through `createMessage` (streaming-aware,
 * with its own span) and `span` here records the two loop-level outcomes
 * (`re_ask_fired`, `final_validation_result`) that only make sense once per
 * `runAgent` call, not per individual model call.
 */
async function runLoop<TIn, TOut>(
  cfg: RunAgentConfig<TIn, TOut>,
  span: Span,
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
    const resp = await createMessage(
      client,
      request(cfg.model, maxTokens, cfg.system, messages, toolDefs),
      cfg.stream,
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
  if (first.ok) {
    span.setAttribute("re_ask_fired", false);
    span.setAttribute("final_validation_result", "ok");
    return first.value;
  }
  span.setAttribute("re_ask_fired", true);

  messages.push({
    role: "user",
    content:
      "Your previous response did not match the required JSON output schema. " +
      `The validation error was:\n${first.error}\n\n` +
      "Return the corrected JSON object only — it must satisfy the schema. " +
      "No prose, no explanation, no markdown code fences.",
  });

  const reask = await createMessage(
    client,
    // No tools on the re-ask: we want a final JSON answer, not another tool call.
    request(cfg.model, maxTokens, cfg.system, messages, []),
    cfg.stream,
  );
  const reaskText = extractText(reask);
  const second = tryParse(cfg.outSchema, reaskText);
  if (second.ok) {
    span.setAttribute("final_validation_result", "ok_after_reask");
    return second.value;
  }

  span.setAttribute("final_validation_result", "failed");
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

/**
 * One "ask Claude" call, wrapped in its own span (model, token counts,
 * latency). Both the tool-use loop and the bounded re-ask route through here
 * so the streaming/non-streaming branch exists in exactly one place. When
 * `onDelta` is present it drives the SDK's streaming path via `streamMessage`
 * and resolves to the same `Anthropic.Message` shape `.create()` returns, so
 * nothing downstream needs to know which path ran.
 */
async function createMessage(
  client: AnthropicClient,
  params: Anthropic.MessageCreateParamsNonStreaming,
  onDelta: ((delta: string) => void) | undefined,
): Promise<Anthropic.Message> {
  return tracer().startActiveSpan("agents.runAgent.model_call", async (span) => {
    const startedAt = Date.now();
    span.setAttribute("model", params.model);
    span.setAttribute("streaming", Boolean(onDelta));
    try {
      const resp = onDelta
        ? await streamMessage(client, params, onDelta)
        : await client.messages.create(params);
      span.setAttribute("input_tokens", resp.usage.input_tokens);
      span.setAttribute("output_tokens", resp.usage.output_tokens);
      span.setAttribute("latency_ms", Date.now() - startedAt);
      span.setStatus({ code: SpanStatusCode.OK });
      return resp;
    } catch (err) {
      span.setAttribute("latency_ms", Date.now() - startedAt);
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Opt-in streaming: the Anthropic SDK's `client.messages.stream(...)`, which
 * returns an object that is async-iterable over `MessageStreamEvent`s and
 * exposes `.finalMessage()` for the same complete `Message` the non-streaming
 * path returns. Emits each text delta to `onDelta` as it arrives; the
 * tool-use loop only ever sees the final `Message`, so it is unchanged either
 * way. `client.messages.stream` is optional on `AnthropicClient` (only the
 * real SDK client, or a test fake that opts into testing streaming, needs to
 * implement it) — a clear error beats a silently-dropped `onDelta` callback.
 */
async function streamMessage(
  client: AnthropicClient,
  params: Anthropic.MessageCreateParamsNonStreaming,
  onDelta: (delta: string) => void,
): Promise<Anthropic.Message> {
  if (!client.messages.stream) {
    throw new Error(
      "runAgent: cfg.stream was set but the injected client has no messages.stream() method",
    );
  }
  const stream = client.messages.stream(params);
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      onDelta(event.delta.text);
    }
  }
  return stream.finalMessage();
}

async function runToolSafely(
  tool: AgentTool | undefined,
  block: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  return tracer().startActiveSpan(
    "agents.runAgent.tool_call",
    async (span): Promise<Anthropic.ToolResultBlockParam> => {
      span.setAttribute("tool_name", block.name);
      try {
        if (!tool) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "unknown tool" });
          return errorResult(block.id, `Unknown tool: ${block.name}`);
        }
        const result = await tool.handler(block.input);
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        };
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(err) });
        // `block.name` (not `tool.name`): TS does not flow the `if (!tool)`
        // guard's narrowing into this catch, and block.name is the same tool
        // name anyway (the tool the model invoked).
        return errorResult(block.id, `Tool "${block.name}" failed: ${errMsg(err)}`);
      } finally {
        span.end();
      }
    },
  );
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

/**
 * SHA-256 hash of the assembled prompt (system + context pack + JSON input) —
 * a span attribute that lets traces be correlated/deduped without ever
 * putting the raw prompt text (which may carry account/PII-adjacent context)
 * into telemetry.
 */
function promptHash<TIn, TOut>(cfg: RunAgentConfig<TIn, TOut>): string {
  const material = `${cfg.system}\n${buildInitialUserContent(cfg)}`;
  return createHash("sha256").update(material).digest("hex");
}
