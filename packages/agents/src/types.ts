/**
 * Shared types for @mstack/agents — the Claude-native agent mechanism.
 * See research/06-architecture.md §3.0 (the `runAgent` contract).
 */
import type { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * A labeled evidence block. The context pack — labeled, retrieved evidence — is
 * "THE lever" per the architecture: what goes into the model's context is the
 * differentiator, not the model choice.
 */
export interface ContextBlock {
  /** short evidence label, e.g. "APPROVED MESSAGING", "SIGNALS", "RULES". */
  label: string;
  /** the evidence text. */
  content: string;
}

/**
 * A Claude tool the agent may call during the tool-use loop. `inputSchema` is a
 * Zod schema (converted to JSON Schema for the tool definition); `handler` runs
 * when Claude calls the tool and returns a JSON-serializable result.
 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler(args: unknown): Promise<unknown>;
}

/**
 * Minimal surface of the SDK's `MessageStream` (what `client.messages.stream(...)`
 * returns) that `runAgent` depends on for opt-in streaming
 * (research/10-sota-integration-design.md §2.1): async-iterable over stream
 * events so text deltas can be extracted, plus `finalMessage()` for the same
 * complete `Message` the non-streaming path already returns — so the tool-use
 * loop needs no separate handling for the streamed case.
 */
export interface AnthropicMessageStream
  extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/**
 * The minimal Anthropic client surface `runAgent` depends on. The real
 * `new Anthropic()` satisfies it; tests inject a fake so the loop runs offline.
 */
export interface AnthropicClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
    /**
     * Optional: only exercised when `RunAgentConfig.stream` is set. Omit it on
     * any fake client that doesn't test streaming — a client without this
     * method is still a fully valid `AnthropicClient` for the (default)
     * non-streaming path, so streaming stays opt-in end-to-end.
     */
    stream?(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): AnthropicMessageStream;
  };
}

/** Config for one `runAgent` call — matches research/06-architecture.md §3.0. */
export interface RunAgentConfig<TIn, TOut> {
  /** model id (from @mstack/core `modelFor` / `modelRouter`). */
  model: string;
  /** tight-scoped, job-as-function system instruction (no identity inflation). */
  system: string;
  /** the request payload (validated upstream by an inbound Zod schema). */
  input: TIn;
  /** structured-output contract; the final answer is coerced + parsed with it. */
  outSchema: z.ZodType<TOut>;
  /** optional Claude tools for the tool-use loop. */
  tools?: AgentTool[];
  /** optional labeled evidence blocks assembled into the request. */
  contextPack?: ContextBlock[];
  /** inject a client for offline tests; omitted → built from ANTHROPIC_API_KEY. */
  client?: AnthropicClient;
  /** max model calls in the tool-use loop before forcing a final answer (default 8). */
  maxToolIterations?: number;
  /** output token ceiling (default 8192). */
  maxTokens?: number;
  /**
   * Opt-in streaming (research/10-sota-integration-design.md §2.1): when
   * present, `runAgent` drives the SDK's streaming API and calls this with
   * each text delta as it arrives. Omit it (the default) to keep the
   * non-streaming path — the tool-use loop behaves identically either way,
   * since both resolve to the same final `Anthropic.Message`.
   */
  stream?: (delta: string) => void;
}
