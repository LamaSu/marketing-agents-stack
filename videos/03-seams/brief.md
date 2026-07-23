# 03-seams — storyboard

**Takeaway (one sentence):** Every external dependency in the Marketing Agents
Stack sits behind a seam with a deterministic offline default -- real providers
are opt-in, swap in without callers changing, and degrade to the default
instead of breaking when unavailable.

**Pattern:** grid-then-zoom (name the whole set, then drill into one concrete
example, then generalize the rule). Dark palette to match marketing-agents-loop.py
and the SignalSphere console. ~80s, on-screen captions, no narration.

## Beats
1. **Hook** (~10s) -- "The loop runs keyless. Offline. No API keys." / "So how
   does it also reach for best-in-class tools?" resolves to: every external
   dependency sits behind a **SEAM** with an offline default.
2. **The seams** (~18s) -- a 6-row grid, each `seam name | offline default ->
   opt-in upgrade`: SignalSource (sample JSONL -> PostHog/GitHub/Segment),
   EnrichmentProvider (fetch+strip -> Crawl4AI/Firecrawl), ScoringProvider
   (rules -> +Claude/+ONNX), OutreachChannel (outbox file -> Composio),
   Executor (in-process -> Hatchet), Recall/Approver (none/portal ->
   Graphiti/HumanLayer). Rows fade in staggered (LaggedStart), then hold.
3. **Zoom into one: FetchSite** (~15s) -- the interface signature, then
   `defaultFetchSite` (fetch+strip) card next to `crawl4aiFetchSite` (JS-render
   sidecar) card, an arrow labeled "register it". Caption: same seam, same
   callers -- nothing downstream changes.
4. **Degrade, don't break** (~13s) -- the crawl4ai card gets an X, a curved
   fallback arrow bends down to the default card, a console-style log strip
   reads "falling back to defaultFetchSite -- degraded, not broken", then "the
   loop keeps running" lands beside the failed card.
5. **The rule** (~14s) -- two columns: Python tools (Crawl4AI, GPT-Researcher,
   Graphiti, Presidio) -> HTTP sidecars, never vendored into the strict-ESM TS
   tree; permissive TS SDKs (Composio, Hatchet, HumanLayer) -> lazy dynamic
   import, never touching the offline module graph. Divider line between them.
6. **Close** (~12s) -- `OutreachChannel.dispatch(...)` still requires a valid
   Approval -- a type on the seam, unaffected by any swap. End tagline: "Adopt
   the best tool. Stay coupled to none."
