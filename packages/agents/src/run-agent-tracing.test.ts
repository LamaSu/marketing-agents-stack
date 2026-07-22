/**
 * Tracing + streaming tests for `run-agent.ts` (Wave B1,
 * research/10-sota-integration-design.md §2.1). Kept in a separate file from
 * `run-agent.test.ts` so the existing 16 offline agents tests (7 in
 * run-agent.test.ts + 9 in tools.test.ts) stay untouched.
 *
 * The OTel span assertions use a hand-rolled in-memory Tracer/Span/
 * TracerProvider built directly against the `@opentelemetry/api` interfaces
 * -- no `@opentelemetry/sdk-trace-base` dependency, so this package's only
 * new runtime dependency stays `@opentelemetry/api` (design §2.1/§3). It only
 * implements what run-agent.ts actually calls: setAttribute, setStatus,
 * recordException, end, and the 2-arg (name, fn) form of startActiveSpan.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  AttributeValue,
  Span,
  SpanStatus,
  Tracer,
  TracerProvider,
} from "@opentelemetry/api";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentOutputError, runAgent } from "./run-agent.js";
import type { AgentTool, AnthropicClient, AnthropicMessageStream } from "./types.js";

/* ─────────────────────────── message fixtures ──────────────────────────── */

/** Build a minimal Anthropic.Message; runAgent only reads a handful of fields.
 *  Non-zero usage (unlike run-agent.test.ts's all-zero fixture) so the
 *  model_call span's token attributes are meaningfully assertable. */
function msg(content: unknown[], stopReason: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

const text = (t: string, stop = "end_turn"): Anthropic.Message =>
  msg([{ type: "text", text: t }], stop);
const toolUse = (id: string, name: string, input: unknown): Anthropic.Message =>
  msg([{ type: "tool_use", id, name, input }], "tool_use");

/** Offline fake client (non-streaming): replays scripted responses in order. */
class FakeClient implements AnthropicClient {
  private readonly queue: Anthropic.Message[];
  constructor(responses: Anthropic.Message[]) {
    this.queue = [...responses];
  }
  messages = {
    create: async (): Promise<Anthropic.Message> => {
      const next = this.queue.shift();
      if (!next) throw new Error("FakeClient: no scripted response left");
      return next;
    },
  };
}

/** Offline fake streaming client: `.stream()` yields scripted text deltas,
 *  then `.finalMessage()` resolves to the scripted final message. `.create()`
 *  throws -- it should never be called when `cfg.stream` is set. */
function fakeMessageStream(
  deltas: string[],
  finalMessage: Anthropic.Message,
): AnthropicMessageStream {
  async function* events(): AsyncGenerator<Anthropic.MessageStreamEvent> {
    for (const t of deltas) {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: t },
      } as unknown as Anthropic.MessageStreamEvent;
    }
  }
  const iterator = events();
  return {
    [Symbol.asyncIterator]: () => iterator,
    finalMessage: async () => finalMessage,
  };
}

class FakeStreamingClient implements AnthropicClient {
  readonly streamCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(
    private readonly deltas: string[],
    private readonly final: Anthropic.Message,
  ) {}
  messages = {
    create: async (): Promise<Anthropic.Message> => {
      throw new Error(
        "FakeStreamingClient.create should not be called when cfg.stream is set",
      );
    },
    stream: (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): AnthropicMessageStream => {
      this.streamCalls.push(params);
      return fakeMessageStream(this.deltas, this.final);
    },
  };
}

/* ────────────────────── in-memory OTel recording fixture ───────────────── */

interface RecordedSpan {
  name: string;
  attributes: Record<string, AttributeValue>;
  status?: SpanStatus;
  ended: boolean;
  exceptionCount: number;
}

function createRecordingProvider(): {
  provider: TracerProvider;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];

  function makeSpan(name: string): Span {
    const record: RecordedSpan = {
      name,
      attributes: {},
      ended: false,
      exceptionCount: 0,
    };
    spans.push(record);
    // run-agent.ts never chains setAttribute/setStatus return values, so
    // these are void -- simpler than modeling the real Span's fluent `this`
    // return, and the `as unknown as Span` cast below papers over the gap.
    return {
      setAttribute(key: string, value: AttributeValue) {
        record.attributes[key] = value;
      },
      setStatus(status: SpanStatus) {
        record.status = status;
      },
      recordException() {
        record.exceptionCount += 1;
      },
      end() {
        record.ended = true;
      },
    } as unknown as Span;
  }

  const tracer = {
    startActiveSpan(name: string, fn: (span: Span) => unknown) {
      return fn(makeSpan(name));
    },
  } as unknown as Tracer;

  const provider = { getTracer: () => tracer } as unknown as TracerProvider;
  return { provider, spans };
}

// Always start each test with no provider registered, regardless of what the
// previous test registered -- keeps the ON (recording) and OFF (no-op)
// scenarios from leaking into each other.
afterEach(() => {
  trace.disable();
});

/* ──────────────────────────────── tests ─────────────────────────────────── */

describe("runAgent tracing — spans (in-memory provider)", () => {
  it("creates one span per runAgent call, with model/prompt_hash and OK status", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ answer: z.string() });
    const out1 = await runAgent({
      model: "claude-test-1",
      system: "sys one",
      input: { q: 1 },
      outSchema,
      client: new FakeClient([text('{"answer":"one"}')]),
    });
    const out2 = await runAgent({
      model: "claude-test-2",
      system: "sys two",
      input: { q: 2 },
      outSchema,
      client: new FakeClient([text('{"answer":"two"}')]),
    });

    expect(out1).toEqual({ answer: "one" });
    expect(out2).toEqual({ answer: "two" });

    // per-call, not a shared singleton span.
    const runSpans = spans.filter((s) => s.name === "agents.runAgent");
    expect(runSpans).toHaveLength(2);

    const [s1, s2] = runSpans;
    expect(s1?.attributes["model"]).toBe("claude-test-1");
    expect(s2?.attributes["model"]).toBe("claude-test-2");

    // prompt-hash, not the raw prompt: a sha256 hex digest that differs per
    // call and never contains the source system text.
    expect(String(s1?.attributes["prompt_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(s1?.attributes["prompt_hash"]).not.toBe(s2?.attributes["prompt_hash"]);
    expect(String(s1?.attributes["prompt_hash"])).not.toContain("sys one");

    expect(s1?.attributes["re_ask_fired"]).toBe(false);
    expect(s1?.attributes["final_validation_result"]).toBe("ok");
    expect(s1?.status?.code).toBe(SpanStatusCode.OK);
    expect(s1?.ended).toBe(true);
  });

  it("creates a model_call span per Claude request with token/latency attributes", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ ok: z.boolean() });
    await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client: new FakeClient([text('{"ok":true}')]),
    });

    const callSpans = spans.filter((s) => s.name === "agents.runAgent.model_call");
    expect(callSpans).toHaveLength(1);
    expect(callSpans[0]?.attributes["model"]).toBe("m");
    expect(callSpans[0]?.attributes["input_tokens"]).toBe(10);
    expect(callSpans[0]?.attributes["output_tokens"]).toBe(5);
    expect(typeof callSpans[0]?.attributes["latency_ms"]).toBe("number");
    expect(callSpans[0]?.attributes["streaming"]).toBe(false);
    expect(callSpans[0]?.status?.code).toBe(SpanStatusCode.OK);
    expect(callSpans[0]?.ended).toBe(true);
  });

  it("creates a tool_call span per tool execution with the tool_name attribute", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ answer: z.string() });
    const lookup: AgentTool = {
      name: "lookup",
      description: "look up a value",
      inputSchema: z.object({ q: z.string() }),
      handler: async (args) => {
        const { q } = z.object({ q: z.string() }).parse(args);
        return { value: `v:${q}` };
      },
    };

    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      tools: [lookup],
      client: new FakeClient([
        toolUse("toolu_1", "lookup", { q: "hi" }),
        text('{"answer":"done"}'),
      ]),
    });

    expect(out).toEqual({ answer: "done" });
    const toolSpans = spans.filter((s) => s.name === "agents.runAgent.tool_call");
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0]?.attributes["tool_name"]).toBe("lookup");
    expect(toolSpans[0]?.status?.code).toBe(SpanStatusCode.OK);
    expect(toolSpans[0]?.ended).toBe(true);
  });

  it("records an ERROR status tool_call span for an unknown tool, but still completes", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ ok: z.boolean() });
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      tools: [],
      client: new FakeClient([
        toolUse("toolu_x", "does_not_exist", {}),
        text('{"ok":true}'),
      ]),
    });

    expect(out).toEqual({ ok: true });
    const toolSpans = spans.filter((s) => s.name === "agents.runAgent.tool_call");
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0]?.attributes["tool_name"]).toBe("does_not_exist");
    expect(toolSpans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
  });

  it("records re_ask_fired=true and final_validation_result=ok_after_reask on a successful re-ask", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ n: z.number() });
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client: new FakeClient([text("not json"), text('{"n":42}')]),
    });

    expect(out).toEqual({ n: 42 });
    const runSpan = spans.find((s) => s.name === "agents.runAgent");
    expect(runSpan?.attributes["re_ask_fired"]).toBe(true);
    expect(runSpan?.attributes["final_validation_result"]).toBe("ok_after_reask");
    expect(runSpan?.status?.code).toBe(SpanStatusCode.OK);

    // one model_call span for the original ask, one for the bounded re-ask.
    const callSpans = spans.filter((s) => s.name === "agents.runAgent.model_call");
    expect(callSpans).toHaveLength(2);
  });

  it("records final_validation_result=failed and ERROR status, then throws AgentOutputError", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ n: z.number() });
    await expect(
      runAgent({
        model: "m",
        system: "s",
        input: {},
        outSchema,
        client: new FakeClient([text("garbage"), text("still garbage")]),
      }),
    ).rejects.toBeInstanceOf(AgentOutputError);

    const runSpan = spans.find((s) => s.name === "agents.runAgent");
    expect(runSpan?.attributes["re_ask_fired"]).toBe(true);
    expect(runSpan?.attributes["final_validation_result"]).toBe("failed");
    expect(runSpan?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan?.exceptionCount).toBeGreaterThan(0);
    expect(runSpan?.ended).toBe(true);
  });
});

describe("runAgent tracing — no-op default (no provider registered)", () => {
  it("runs the simple round trip unchanged under the OTel no-op tracer", async () => {
    trace.disable(); // belt-and-suspenders on top of the global afterEach
    const outSchema = z.object({ answer: z.string() });
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client: new FakeClient([text('{"answer":"done"}')]),
    });
    expect(out).toEqual({ answer: "done" });
  });

  it("runs the tool-use round trip unchanged under the OTel no-op tracer", async () => {
    trace.disable();
    const outSchema = z.object({ ok: z.boolean() });
    let toolCalls = 0;
    const lookup: AgentTool = {
      name: "lookup",
      description: "d",
      inputSchema: z.object({ q: z.string() }),
      handler: async () => {
        toolCalls++;
        return { ok: true };
      },
    };
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      tools: [lookup],
      client: new FakeClient([
        toolUse("toolu_1", "lookup", { q: "hi" }),
        text('{"ok":true}'),
      ]),
    });
    expect(out).toEqual({ ok: true });
    expect(toolCalls).toBe(1);
  });
});

describe("runAgent streaming (opt-in)", () => {
  it("drives the stream callback with text deltas and returns the parsed final message", async () => {
    const outSchema = z.object({ answer: z.string() });
    const client = new FakeStreamingClient(
      ['{"ans', 'wer":"done"}'],
      text('{"answer":"done"}'),
    );
    const received: string[] = [];

    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client,
      stream: (delta) => received.push(delta),
    });

    expect(out).toEqual({ answer: "done" });
    expect(received).toEqual(['{"ans', 'wer":"done"}']);
    expect(client.streamCalls).toHaveLength(1);
  });

  it("marks the model_call span streaming=true when cfg.stream is set", async () => {
    const { provider, spans } = createRecordingProvider();
    trace.setGlobalTracerProvider(provider);

    const outSchema = z.object({ answer: z.string() });
    const client = new FakeStreamingClient(["done"], text('{"answer":"done"}'));
    await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client,
      stream: () => {},
    });

    const callSpans = spans.filter((s) => s.name === "agents.runAgent.model_call");
    expect(callSpans).toHaveLength(1);
    expect(callSpans[0]?.attributes["streaming"]).toBe(true);
  });

  it("the non-streaming path is the default: omitting cfg.stream never calls client.messages.stream", async () => {
    const outSchema = z.object({ ok: z.boolean() });
    const createCalls: unknown[] = [];
    const streamCalls: unknown[] = [];
    // A client capable of BOTH paths, so the assertion actually distinguishes
    // "cfg.stream omitted -> create() used" from "the client just lacks stream()".
    const dualClient: AnthropicClient = {
      messages: {
        create: async (params) => {
          createCalls.push(params);
          return text('{"ok":true}');
        },
        stream: (params) => {
          streamCalls.push(params);
          return fakeMessageStream(["unused"], text('{"ok":true}'));
        },
      },
    };

    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client: dualClient,
      // cfg.stream intentionally omitted
    });

    expect(out).toEqual({ ok: true });
    expect(createCalls).toHaveLength(1);
    expect(streamCalls).toHaveLength(0); // never touched when cfg.stream is unset
  });

  it("throws a clear error when cfg.stream is set but the client has no messages.stream()", async () => {
    const outSchema = z.object({ ok: z.boolean() });
    const client: AnthropicClient = {
      messages: {
        create: async () => text('{"ok":true}'),
        // no `stream` method on purpose
      },
    };
    await expect(
      runAgent({
        model: "m",
        system: "s",
        input: {},
        outSchema,
        client,
        stream: () => {},
      }),
    ).rejects.toThrow(/messages\.stream/);
  });
});
