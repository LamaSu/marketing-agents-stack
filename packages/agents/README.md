# @mstack/agents

The Claude-native agent **mechanism** every product agent (`@mstack/reviewer`, `@mstack/account-intel`) calls. No LangChain — just the Anthropic SDK (`@anthropic-ai/sdk`) + Zod. This is the "how you call Claude" layer; the products are built on it. See `research/06-architecture.md` §3.0.

## `runAgent(cfg)`

One call assembles the system prompt + labeled **context pack** + JSON input into a Messages API request, runs the Claude **tool-use loop** (model call → run tool handlers → feed `tool_result` back → repeat), then coerces the final assistant text to JSON and validates it with your Zod `outSchema`. On a parse/validation failure it does **exactly one** bounded re-ask (feeding the Zod error text back), then returns the typed output or throws `AgentOutputError`.

```ts
import { runAgent, retrieveTool, contextPack, modelRouter } from "@mstack/agents";
import { z } from "zod";

const out = await runAgent({
  model: modelRouter("reviewerJudge"),            // @mstack/core model map (opus)
  system: "You produce a claim-drift review. Return only the JSON.",
  input: { partnerId: "abc", content: "…" },
  outSchema: z.object({ score: z.number(), findings: z.array(z.string()) }),
  tools: [retrieveTool(corpus)],                  // seam-backed Claude tools
  contextPack: [{ label: "APPROVED MESSAGING", content: passages }],
});
```

The Anthropic client is **injectable** (`client` in the config). Omit it and it is built from `ANTHROPIC_API_KEY`; inject a fake in tests so the loop runs fully offline (no key, no network).

## Built-in tools (thin wrappers over the `@mstack/core` seams)

- `retrieveTool(corpus: GuidelineCorpus)` — top-k approved-messaging passages (grounding "is this claim supported?").
- `sqlQueryTool(query)` — read-only warehouse query (an account's persisted signals/history).
- `enrichTool(provider: EnrichmentProvider)` — company → firmographic record with provenance.

Each converts its Zod `inputSchema` → JSON Schema (`toInputSchema`, via `zod-to-json-schema`) for the tool definition, validates the model's arguments, and returns a JSON result. A thrown validation error is surfaced back to Claude as an `is_error` tool_result so it can recover.

## Context pack — the differentiator

`contextPack(blocks)` renders labeled evidence blocks (`<evidence label="…">`). Per the architecture, what goes into context is the lever, not the model choice — labeling lets the agent cite which evidence a conclusion came from.

## Prompt hygiene

`checkPromptHygiene(system)` is an advisory linter (returns warnings, never throws): system prompts are **job-as-function** ("You produce X"), never identity inflation ("elite/world-class"), and carry no panic/urgency framing. Calm baselines measurably lower misaligned output — it matters most in the compliance reviewer.

## Build / test

`pnpm --filter @mstack/agents build|test`. Tests are offline (fake client). **Do not `pnpm install` on the dev tablet** (see `docs/build-conventions.md`) — the consolidated install/build/test runs on Spark.
