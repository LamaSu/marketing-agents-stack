# GPT-Researcher sidecar (opt-in, for the `deepResearch` tool)

`@mstack/agents`' `deepResearchTool` talks to a **GPT-Researcher** HTTP sidecar —
never a vendored dependency (Python tool → separate process, per
`docs/build-conventions.md`). It is **opt-in**: the keyless `mstack demo` never
constructs the tool, never needs this sidecar. GPT-Researcher is **Apache-2.0**
(assafelovic/gpt-researcher).

## Run it

GPT-Researcher ships its own server image. The simplest path:

```bash
# needs your own search + LLM keys (this is the "online + keyed" path by design)
docker run -d --name gpt-researcher -p 8001:8000 \
  -e OPENAI_API_KEY=sk-...        \
  -e TAVILY_API_KEY=tvly-...      \
  gptresearcher/gpt-researcher

# point the tool at it
export GPTR_URL=http://localhost:8001
```

(Route those keys through gatecraft/Infisical in a real deployment rather than
raw env — see `research/10-sota-integration-design.md` §2.10 / Wave D2. The
credential-boundary work is out of scope for the C2 tool itself.)

## Contract the tool assumes

`POST {GPTR_URL}/report/`

```jsonc
// request
{ "task": "<the research question>", "report_type": "research_report", "report_source": "web" }

// response (field names vary by version — the tool reads the first that fits)
{ "report": "<markdown report>", "source_urls": ["https://…"] }
//   report      ← report | research_information | answer | output
//   source_urls ← source_urls | sources | []
```

**Assumption, verify on a live server.** Written without standing up a real
container (per `docs/build-conventions.md`). If a live server's request or
response shape differs, widen `GptrReportResponse` / `extractReport` in
`packages/agents/src/deep-research.ts` — the tool signature and its tests are
unaffected. On ANY failure the tool returns `{ ok: false, ... }` (degraded) and
the agent falls back to its persisted signals; it never throws or blocks.

## Why it's a tool, not a replacement

The offline SDR-Researcher stays bound to persisted `signalId`s ("never invent a
signal"). `deep_research` is an extra capability the agent may call when it needs
external context a signal can't give — available only when a deployer wires it in
(online + keyed). See `research/10-sota-integration-design.md` §2.3 (Wave C2).
