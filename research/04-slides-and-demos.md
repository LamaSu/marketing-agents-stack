# Slides & Live Demos — reconstructed from the video (11 distinct slides + 5 samples)

Two speakers each showed a **framework slide + a live product demo**. These are near-complete
reference designs. (Fictional names in the demos: **KLZ** = the vendor stand-in for Anthropic,
**ABC Corp / Northland / Victorly / BrightPath / Acme Cloud** = partner stand-ins.)

---

## TALK 1 — Saqib Mustafa (Anthropic): "Partner Content Portal" (live demo)

A web app: **Partner Content Portal — Partner Marketing**. Tabs: **Submit Content · Review Dashboard · INTERNAL**.

### Submit Content (input)
- Fields: **Partner** (dropdown, e.g. "ABC Corp"), **Content title**, **Content type** (Blog post / …), **Content** (textarea).
- Buttons: `Submit for review`, `Load ABC Corp sample draft`, `Clear`.

### The rubric (right panel "What the review checks")
| Score | Changes | Meaning |
|---|---|---|
| 5 | 0 | Okay to publish |
| 4 | 1–2 | Minor edits |
| 3 | 3 | Moderate revision |
| 2 | 4 | Significant revision |
| 1 | 5+ | Needs a lot of work |

### Review findings (the AI output) — categorized claim-drift, each with a Recommended change
Every finding = **category** + `REQUIRED` tag + the offending quote + a **Recommended change**. Observed categories:
1. **Guaranteed-outcome language** — e.g. *"guarantees a 10x ROI in the first year… no other platform comes close"* → never use "guarantee" for outcomes; if you have citable customer results, phrase as "customers have reported…" and submit the source.
2. **Quantitative claim without citation** — e.g. *"10x ROI"* → quantitative claims need a published source or written approval; cite the study or remove the figure.
3. **Unapproved superlative claim** — e.g. *"no other platform on the market comes close"* → describe what the joint solution does concretely instead (e.g. "automates document-heavy workflows across finance, legal, ops").
4. **Unapproved spokesperson quote** — e.g. a quote *"…said Morgan Hale, Chief Marketing Officer at KLZ"* → quotes attributed to KLZ employees must be supplied/approved in writing for this specific piece; remove or request an approved one.
5. **Roadmap disclosure** — e.g. *"KLZ will be launching its Agent Marketplace in Q4 2026, and ABC DataFlow will be featured…"* → remove references to unannounced products/features/dates; roadmap comms come from KLZ only; describe what the solution does today.
6. **Badge / partner-tier misuse** — e.g. *"Powered by KLZ" badge* → that badge is Elite-tier only; a Select partner must use the "KLZ Select Partner" designation.

### Outputs / actions (buttons)
`View in Review Dashboard` · `View drafted partner email` · `Review for partner (Word)` · `Review for partner (Google Docs)`
→ i.e. the agent also **drafts the partner-facing email** and an **exportable annotated review** (Word/GDocs). Draft-first; human sends.

### Review Dashboard (table)
Columns: **Partner · Content title · Date · Status · Findings · Email**.
Status is color-coded **RETURNED** (has required changes) vs **APPROVED**. Rows span many partners
(ABC Corp RETURNED, Northland Analytics APPROVED, Victorly, BrightPath, Acme Cloud, …), each with
`Findings` and `Email` links. This is the queue/audit view for the partner-marketing team.

**→ Build target #1: an Asset-Review / Claim-Drift agent + portal.** Corpus of approved messaging + a
claim/brand-rule ledger → rubric-scored review with categorized findings + recommended edits → dashboard + drafted partner email.

---

## TALK 2 — Guan Wang: "The AI-Native Decision System" + "SignalSphere AI" (live demo)

### Framing slides
- **"16+ Years Building Data + AI Organizations"** (Docusign · Navan · Snowflake · Airtable).
  *Industry Evolution: Analytics → Data Science → Data Platform → Machine Learning → **AI Operating System**.*
  **One Observation: "Every tech wave changed software. AI is changing how organizations make decisions."**
- **"Industry Examples"** (seen at 60:00): **Anthropic** — *Frontier Architecture* (model builders run Claude natively inside their operational data infra); *Operational Engine* (Claude as an active engine stitched into core data assets, not a chat box). **Snowflake** — *Embedded Intelligence* (continuous feedback loop into the data platform); *Advanced Capabilities* (native AI like **Cortex Sense**, **Horizon Context**).

### THE core framework — "The AI-Native Decision System"
> "The competitive advantage isn't more AI — it's **better decision loops**."

A 4-stage pipeline (left axis **Smarter Decisions**, right axis **Actions**):

| 1. Unify Customer Signals | 2. Understand Buyers | 3. Build Decision Context | 4. Autonomous Agents |
|---|---|---|---|
| real-time customer journey | who's likely to buy + **when & why** | turn signals → business context | execute within guardrails, humans in control |
| CRM · Product usage · Campaign engagement · Sales activities · Third-party signals | Predictive ML · LLM reasoning · Customer memory · Behavioral signals | Next-best account · Buying committee · Customer intent · Propensity · Lifecycle stage | Continuously monitor signals · Prioritize accounts in real time · Coordinate cross-channel campaigns · Personalize outreach at scale |

Flow: **New Signals → … → Business Outcomes**. Foundation bar: **AI-Native Foundation: Trusted Data · Shared Memory · Governance · Feedback Learning.**

### SignalSphere AI (live demo) — "Autonomous Activation Console"
Top bar: *"Industry Best Practice: Pairing ML predictive models (scoring) with Agentic AI (reasoning & action) yields **3.4× higher conversion**."* · `ACTIVE AGENTS: 4 Workers` · `AUTONOMOUS RUNS: 1,842` · `PIPELINE VELOCITY: +24.6%` · **Copilot ↔ Autopilot** toggle.

Four panels (left→right = the framework, live):
1. **Snowflake Data Layer — "Ingested Signal Stream"**: unified warehouse streaming raw multi-signals directly into ML models. Live events e.g. *"Zoom clicked direct-mail invite code AUTONOMY", "Notion downloaded enterprise orchestration guidelines."*
2. **ML Scoring Engine**: ranked ICP accounts with scores + "+N signals stitched" — e.g. *Vercel 78/100 (Enterprise ICP)*, *Airtable 89/100 (Mid-Market ICP)*, *Stripe 76/100 (Strategic ICP)*.
3. **Agentic Orchestration Hub — "Active Specialized Workers"**: **SDR Researcher · Copywriter AI · GTM Router**, with a live **"Swarm Reasoning Engine"** log (SDR Researcher reads Snowflake tables for metrics on figma.com; Copywriter AI loads buying-group timeline; agents run in parallel). Note: *"Agent is enabled. Awaiting **human validation** inside active dashboard panel."* → HITL gate. Then *"GTM SWARM ACTIVATED: Autonomous Agent execution allowed. Continuous monitoring and auto-outreach sequence starting."*
4. **Resolution & Action Studio — "Target Insight Console"**: a chosen target (Figma Design); **Buying-Group Persona Heatmap** (Engineering / Product / Security); **Buying-Group Committee** (e.g. *Aris Thorne — SVP Engineering*; *Linus Sterling — Principal Designer & System Architect, "Key Technical Influence"*); **Multi-Touch Activity Timeline**; **Agentic Copywriter Sequence Play** — a personalized drafted message: *"Hi Aris, with Figma expanding collaborative canvas architectures, scaling infrastructure dynamically is paramount. Since Linus has been reviewing our scaling protocols, I'd love to run a custom performance benchmark against your sandbox endpoints."*

**→ Build target #2: an Account-Intelligence / Signal-Activation engine** — ingest multi-signal stream → ML/LLM ICP scoring → specialized agent swarm (researcher/copywriter/router) → resolve buying committee + next-best-action → draft personalized outreach → **human-validation gate** → (opt-in) autonomous activation. Compounding memory across runs.

---

## Audience signal (from chat overlays)
- Opening poll: *"Where are you with AI in your marketing workflow?"* 1) still experimenting 2) some AI tools, no real workflow 3) built agent(s) that actually run 4) figuring out where to start.
- A GTM engineer asked: *"I need to build this data layer → AI system. 1) what tool stack for enrichment/telemetry? 2) as a newbie, best ways to get to / stay at the cutting edge?"* ← **exactly our target user for a drop-in OSS stack.**
- (joke, but on-theme) *"someone Granola'd the session, put it on an agent and serve it as an MCP with x402 so you could get half the people here to pay you for it"* — MCP + x402 monetization is literally our wheelhouse.

## Synthesis note
The two demos are the two halves of one loop: **Guan's SignalSphere = signal→decision→outreach (inbound/outbound activation); Saqib's Portal = content/claim governance (brand-safe activation).** A drop-in "Marketing Agents in Production" stack = both, on an open runtime (chorus) with draft-first HITL gates (workflow-bridge) and brokered creds (gatecraft).
