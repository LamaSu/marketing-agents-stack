# marketing-agents-loop — storyboard

**Takeaway (one sentence):** The Marketing Agents Stack turns "signal → decision →
action → memory" into one closed loop — two Claude agents in the middle, a human
gate before any send, and a memory that compounds every run.

**Pattern:** state-machine / data-flow loop (the loop is the hero). Dark palette to
match the console. ~75s, on-screen captions, no narration.

## Beats
1. **Title** (~5s) — "Marketing Agents Stack" + "signal → decision → action → memory".
2. **The Gap** (~11s) — "The Signal-to-Decision Gap": GTM sources (Marketo, LinkedIn,
   RollWorks, Outreach, Salesforce) pour captured intent in; a dashed "?" arrow to a
   greyed "timely action". Caption: captures intent, struggles to act in time.
3. **The Insight** (~8s) — two demo boxes (Anthropic reviewer · signals→outreach) slide
   together → "two halves of ONE loop".
4. **The Loop** (~16s, hero) — 4 nodes SIGNAL → DECIDE → ACT → MEMORY in a row with a
   curved return arrow; a token travels the ring; each node lights up. Sub-labels name
   the real pieces (SignalSource; context+enrich+Hybrid score; draft-first + human gate +
   dispatch; DuckDB + hash-chained audit).
5. **Inside DECIDE** (~12s) — the two flagship agents: Claim-Drift Reviewer (score 1–5,
   6 categories) and the Account-Intel swarm (SDR-Researcher → Copywriter → GTM-Router).
6. **3 Guardrails** (~13s) — reviewer≠generator (a type) · human approves every send (one
   gated path) · keep every record (memory compounds).
7. **Close** (~8s) — Open · Offline-first · Claude-native · on chorus + gatecraft; 14
   packages, ~280 tests, the loop runs offline.
