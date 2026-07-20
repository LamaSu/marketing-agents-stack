/** Client resolution: inject one for tests, or build from ANTHROPIC_API_KEY. */
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicClient } from "./types.js";

/**
 * Return the injected client, or construct a real Anthropic client that reads
 * `ANTHROPIC_API_KEY` from the environment. Injecting a fake keeps tests offline.
 */
export function resolveClient(client?: AnthropicClient): AnthropicClient {
  if (client) return client;
  return new Anthropic() as AnthropicClient;
}
