"""Marketing Agents Stack — THE BLUEPRINT.

Contract-level: the type shapes, seam signatures, pipeline I/O, and exact
algorithms/invariants from which the implementation is inferable. Dense by design
(pause-to-study). Plain Manim CE, no LaTeX; code shown as monospace Paragraph.
Render: python .../scripts/render.py --scene stack-blueprint.py --quality l
"""
from manim import *

BG = "#0d1117"
H = "#7ee787"   # header green
SIG = "#79c0ff" # blue
GLD = "#e3b341"
PUR = "#d2a8ff"
ORG = "#ffa657"
RED = "#ff7b72"
GRY = "#8b949e"


def header(txt, color=H):
    return Text(txt, font="Monospace", weight=BOLD, color=color).scale(0.58).to_edge(UP, buff=0.5)


def code(lines, color="#c9d1d9", fs=22, lh=0.62):
    p = Paragraph(*lines, font="Monospace", font_size=fs, line_spacing=lh, color=color)
    return p


def panel(mob, color=GRY, buff=0.35):
    r = SurroundingRectangle(mob, color=color, corner_radius=0.12, buff=buff, stroke_width=2)
    return VGroup(r, mob)


def infer(txt, color=H):
    return Text(txt, color=color).scale(0.4).to_edge(DOWN, buff=0.6)


class StackBlueprint(Scene):
    def wipe(self):
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.35)

    def beat(self, head_txt, head_color, code_lines, code_color, infer_txt, hold=2.2, fs=22):
        self.play(FadeIn(header(head_txt, head_color)))
        body = code(code_lines, code_color, fs=fs)
        pnl = panel(body, color=head_color)
        pnl.move_to(ORIGIN).shift(UP * 0.2)
        self.play(FadeIn(pnl, shift=UP * 0.2))
        self.play(FadeIn(infer(infer_txt)))
        self.wait(hold)
        self.wipe()

    def construct(self):
        self.camera.background_color = BG

        # 0. TITLE
        t = Text("Marketing Agents Stack", weight=BOLD).scale(1.0)
        s = Text("the blueprint — the contracts that determine the code",
                 font="Monospace", color=H).scale(0.4).next_to(t, DOWN, buff=0.3)
        self.play(Write(t)); self.play(FadeIn(s, shift=UP * 0.3)); self.wait(1.3); self.wipe()

        # 1. DOMAIN MODEL (core) — the primitives that carry behavior
        self.beat("@mstack/core  —  domain model (Zod)", SIG, [
            "Signal   { id, ts, source,",
            "           kind: product_usage|crm|campaign|intent,",
            "           actor{userId?,email?,company?}, action? }",
            "Account  { id, domain, firmographic,",
            "           provenance: field->source, score?, tier? }",
            "Draft    { id, kind, refId, body,",
            "           status: pending|approved|rejected|dispatched }",
            "Approval { id, draftId, decision, prevHash, hash }",
        ], "#c9d1d9", "10 primitives; Draft.status + Approval.hash carry the guardrails", hold=2.8, fs=20)

        # 2. THE 5 SEAMS (core) — every dependency hides behind one
        self.beat("@mstack/core  —  5 adapter seams", GLD, [
            "SignalSource        pull(opts?)        -> Signal[]",
            "EnrichmentProvider  enrich(ref)        -> Record",
            "ScoringProvider     score(acct,sigs)   -> {score,tier,rationale}",
            "GuidelineCorpus     ingest · retrieve(q,k) · rules()",
            "OutreachChannel     dispatch(draft, approval) -> Outcome",
            "                                        ^ REQUIRES an Approval",
        ], "#c9d1d9", "default impl = sample (offline); swap to real to go live", hold=2.8, fs=21)

        # 3. GUARDRAIL #1 — a type, not a hope
        self.beat("@mstack/reviewer  —  reviewer != generator", SIG, [
            "ReviewResult {",
            "  score: 1..5, changesCount, verdict: APPROVED|RETURNED,",
            "  findings: Finding[], summary        // <- no prose field",
            "}",
            "Finding { category(6), required, quote,",
            "          recommendedChange,          // an INSTRUCTION",
            "          supportingPassageId | null }",
            "rubric:  changes 0->5  1-2->4  3->3  4->2  5+->1",
        ], "#c9d1d9", "the output type cannot hold marketing copy -> it can't generate", hold=3.0, fs=20)

        # 4. THE REVIEW PIPELINE — inferable from the types
        self.beat("@mstack/reviewer  —  the pipeline", SIG, [
            "reviewAsset(req) =",
            "  1 segment(req.content)",
            "  2 scanDeterministic -> FindingDraft[]  (lexicon/regex)",
            "  3 extractClaims (Claude/sonnet)",
            "  4 corpus.retrieve(claim, k)  (LanceDB + bge-small)",
            "  5 judge (Claude/opus): supported|drifted|unsupported",
            "  6 scoreForChanges -> ReviewResult + drafts (pending)",
        ], "#c9d1d9", "deterministic priors + grounded Claude judge; drafts, never sends", hold=2.8, fs=20)

        # 5. THE AGENT MECHANISM
        self.beat("@mstack/agents  —  runAgent", H, [
            "runAgent<In,Out>({",
            "  model, system, input, outSchema, tools?, contextPack",
            "}) -> Out",
            "  loop: messages.create(...)",
            "        if tool_use: run handler, feed tool_result -> repeat",
            "  coerce JSON -> outSchema.safeParse",
            "        -> 1 bounded re-ask on failure",
        ], "#c9d1d9", "structured output + tool-use + one re-ask.  no LangChain", hold=2.8, fs=21)

        # 6. ACCOUNT-INTEL SWARM
        self.beat("@mstack/account-intel  —  activateAccount", ORG, [
            "resolveAccount: signals + enrich -> Account(provenance)",
            "rankAccounts: ScoringProvider -> top-N     (noise filter)",
            "swarm:",
            "  SDR-Researcher -> relevantSignals[{signalId, why}], committee",
            "  Copywriter     -> Draft(outreach_email, pending)",
            "  GTM-Router     -> {action, channel, targetMember}",
            "=> AccountDecision + pending Draft",
        ], "#c9d1d9", "SDR cites only INPUT signalIds -> bound to real data, no hallucination", hold=2.9, fs=20)

        # 7. SCORING + ENRICHMENT — composed contracts
        self.beat("adapters-scoring + enrichment", GLD, [
            "HybridScorer.score(acct, sigs):",
            "  if rules.tier == DISQUALIFIED: return floor   // hard",
            "  else max(rules, weighted(onnx, claude))",
            "       -> {score, tier, rationale}",
            "",
            "mergeEnrichment: trust registry > llm-web > paid,",
            "                 per-field provenance (resolve, don't average)",
        ], "#c9d1d9", "a disqualifier can't be rescued by LLM optimism", hold=2.7, fs=21)

        # 8. MEMORY + HASH CHAIN
        self.beat("@mstack/memory  —  audit", PUR, [
            "DuckDB: one table / primitive (JSON data + indexed keys)",
            "",
            "appendApproval(a):",
            "  a.prevHash = lastRow.hash            (or GENESIS)",
            "  a.hash = sha256(a.prevHash +",
            "                  canonicalJSON(a without hash))",
            "verifyAuditChain(): recompute every link",
        ], "#c9d1d9", "approvals are an append-only, tamper-evident chain", hold=2.7, fs=21)

        # 9. THE DISPATCH GATE — the send contract
        self.beat("@mstack/runtime  —  dispatchDraft (the ONE send path)", ORG, [
            "persisted = memory.getDraft(draft.id)   // record, not args",
            "refuse if persisted.status == 'dispatched'",
            "assert approval.decision=='approve'",
            "    && approval.draftId == persisted.id",
            "    && persisted.status == 'approved'",
            "assert approval is a real hash-chained row",
            "    && verifyAuditChain()",
            "-> channel.dispatch -> status='dispatched' -> Outcome",
        ], "#c9d1d9", "verified against the SYSTEM OF RECORD -> a forged draft can't send", hold=3.0, fs=20)

        # 10. OFFLINE-FIRST + CLOSE
        self.play(FadeIn(header("the pattern", H)))
        close = code([
            "every seam has a `sample` default",
            "   -> the whole loop runs with NO key, NO network",
            "swap sample -> real  (one file) to go live",
            "",
            "chorus = runtime   gatecraft = credential broker",
            "12 packages · ~280 tests · Claude-native",
        ], "#c9d1d9", fs=22)
        self.play(FadeIn(panel(close, color=H).shift(UP * 0.1)))
        self.play(FadeIn(Text("these contracts determine the code — the rest is implementation",
                              color=H).scale(0.42).to_edge(DOWN, buff=0.6)))
        self.wait(2.4)
        self.play(*[FadeOut(m) for m in self.mobjects])
