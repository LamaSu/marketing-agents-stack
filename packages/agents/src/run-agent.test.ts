import { describe, it, expect } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, AgentOutputError } from "./run-agent.js";
import type { AgentTool, AnthropicClient } from "./types.js";

/** Build a minimal Anthropic.Message; runAgent only reads `.content` + `.stop_reason`. */
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
      input_tokens: 0,
      output_tokens: 0,
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

/** Offline fake client: replays scripted responses in order, records every request. */
class FakeClient implements AnthropicClient {
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly queue: Anthropic.Message[];
  constructor(responses: Anthropic.Message[]) {
    this.queue = [...responses];
  }
  messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message> => {
      // Snapshot messages at call time — runAgent keeps mutating the live array.
      this.calls.push({ ...params, messages: params.messages.slice() });
      const next = this.queue.shift();
      if (!next) throw new Error("FakeClient: no scripted response left");
      return next;
    },
  };
}

describe("runAgent — tool-use loop", () => {
  it("runs a tool_use round, then returns schema-valid output", async () => {
    const outSchema = z.object({ answer: z.string() });
    let toolCalls = 0;
    const lookup: AgentTool = {
      name: "lookup",
      description: "look up a value",
      inputSchema: z.object({ q: z.string() }),
      handler: async (args) => {
        toolCalls++;
        const { q } = z.object({ q: z.string() }).parse(args);
        return { value: `v:${q}` };
      },
    };
    const client = new FakeClient([
      toolUse("toolu_1", "lookup", { q: "hi" }),
      text('{"answer":"done"}'),
    ]);

    const out = await runAgent({
      model: "claude-test",
      system: "You look things up.",
      input: { question: "hi?" },
      outSchema,
      tools: [lookup],
      client,
    });

    expect(out).toEqual({ answer: "done" });
    expect(toolCalls).toBe(1);
    expect(client.calls.length).toBe(2);
    // the second request must carry the tool_result back to the model
    const second = client.calls[1]!;
    const lastMsg = second.messages[second.messages.length - 1]!;
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const blocks = lastMsg.content as Anthropic.ContentBlockParam[];
    expect(blocks[0]?.type).toBe("tool_result");
  });

  it("returns an is_error tool_result for an unknown tool, then completes", async () => {
    const outSchema = z.object({ ok: z.boolean() });
    const client = new FakeClient([
      toolUse("toolu_x", "does_not_exist", {}),
      text('{"ok":true}'),
    ]);
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      tools: [],
      client,
    });
    expect(out).toEqual({ ok: true });
    const results = client.calls[1]!.messages.at(-1)!
      .content as Anthropic.ContentBlockParam[];
    const tr = results[0] as Anthropic.ToolResultBlockParam;
    expect(tr.is_error).toBe(true);
  });
});

describe("runAgent — bounded re-ask", () => {
  it("does exactly one re-ask on non-JSON output, then succeeds", async () => {
    const outSchema = z.object({ n: z.number() });
    const client = new FakeClient([text("this is not json"), text('{"n":42}')]);
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client,
    });
    expect(out).toEqual({ n: 42 });
    expect(client.calls.length).toBe(2);
    // the re-ask must feed the failure back to the model
    const reaskMsg = client.calls[1]!.messages.at(-1)!;
    expect(String(reaskMsg.content)).toContain("did not match");
  });

  it("re-asks once on schema-invalid JSON (wrong field type)", async () => {
    const outSchema = z.object({ n: z.number() });
    const client = new FakeClient([
      text('{"n":"not-a-number"}'),
      text('{"n":7}'),
    ]);
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client,
    });
    expect(out).toEqual({ n: 7 });
    expect(client.calls.length).toBe(2);
  });

  it("throws AgentOutputError after a single failed re-ask (never a second re-ask)", async () => {
    const outSchema = z.object({ n: z.number() });
    const client = new FakeClient([text("garbage"), text("still garbage")]);
    await expect(
      runAgent({ model: "m", system: "s", input: {}, outSchema, client }),
    ).rejects.toBeInstanceOf(AgentOutputError);
    expect(client.calls.length).toBe(2); // exactly one re-ask, then it gives up
  });
});

describe("runAgent — output coercion & request assembly", () => {
  it("strips ```json fences before parsing (no re-ask needed)", async () => {
    const outSchema = z.object({ ok: z.boolean() });
    const client = new FakeClient([text('```json\n{"ok":true}\n```')]);
    const out = await runAgent({
      model: "m",
      system: "s",
      input: {},
      outSchema,
      client,
    });
    expect(out).toEqual({ ok: true });
    expect(client.calls.length).toBe(1);
  });

  it("assembles system + context-pack + JSON input into the first request", async () => {
    const outSchema = z.object({ ok: z.boolean() });
    const client = new FakeClient([text('{"ok":true}')]);
    await runAgent({
      model: "m",
      system: "SYSTEM-INSTRUCTION",
      input: { foo: "bar" },
      outSchema,
      contextPack: [{ label: "EVIDENCE", content: "the-evidence" }],
      client,
    });
    const first = client.calls[0]!;
    expect(first.system).toBe("SYSTEM-INSTRUCTION");
    const userContent = String(first.messages[0]!.content);
    expect(userContent).toContain("EVIDENCE");
    expect(userContent).toContain("the-evidence");
    expect(userContent).toContain('"foo": "bar"');
    expect(first.tools).toBeUndefined(); // no tools passed → field omitted
  });
});
