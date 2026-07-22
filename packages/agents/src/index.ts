/**
 * @mstack/agents — the Claude-native agent mechanism every product agent calls.
 * `runAgent` (tool-use loop + Zod-validated structured output + one bounded
 * re-ask), the built-in tool factories over the core seams, the context-pack
 * builder, and the model router. No LangChain.
 */
export { runAgent, AgentOutputError } from "./run-agent.js";
export { contextPack } from "./context-pack.js";
export { retrieveTool, sqlQueryTool, enrichTool } from "./tools.js";
export { deepResearchTool } from "./deep-research.js";
export { modelRouter } from "./model-router.js";
export { resolveClient } from "./client.js";
export { toInputSchema } from "./json-schema.js";
export { checkPromptHygiene } from "./hygiene.js";

export type { AgentRole } from "./model-router.js";
export type { PromptHygieneWarning } from "./hygiene.js";
export type { DeepResearchConfig, DeepResearchResult } from "./deep-research.js";
export type {
  AgentTool,
  ContextBlock,
  RunAgentConfig,
  AnthropicClient,
  AnthropicMessageStream,
} from "./types.js";
