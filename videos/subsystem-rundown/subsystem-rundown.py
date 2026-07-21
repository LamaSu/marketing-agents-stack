"""Marketing Agents Stack — subsystem rundown (how each package actually works).

Plain Manim CE, no LaTeX. Dark palette. Names the real modules/functions/data flow.
Render: python .../scripts/render.py --scene subsystem-rundown.py --quality l
"""
from manim import *

BG = "#0d1117"
CORE = "#c9d1d9"
SIG = BLUE
MEM = PURPLE
ENR = TEAL
SCO = GOLD
AGT = "#7ee787"
REV = BLUE
ACC = ORANGE
CRED = MAROON
RUN = GOLD
APP = TEAL


def mono(s, color=AGT, scale=0.6, weight=BOLD):
    return Text(s, font="Monospace", color=color, weight=weight).scale(scale)


def header(name, color=AGT):
    return mono(name, color=color, scale=0.62).to_edge(UP, buff=0.55)


def box(label, color, w=3.0, h=1.1, tscale=0.42, sub=None, sscale=0.3, mono_label=False):
    r = RoundedRectangle(width=w, height=h, corner_radius=0.16, color=color,
                         fill_color=color, fill_opacity=0.15, stroke_width=2.5)
    t = (mono(label, color=WHITE, scale=tscale, weight=BOLD) if mono_label
         else Text(label, color=WHITE, weight=BOLD).scale(tscale))
    parts = [t]
    if sub:
        parts.append(Text(sub, color=GREY_B).scale(sscale))
    inner = VGroup(*parts).arrange(DOWN, buff=0.1).move_to(r.get_center())
    return VGroup(r, inner)


def cap(s, color=GREY_A, scale=0.4):
    return Text(s, color=color).scale(scale).to_edge(DOWN, buff=0.65)


def arrow(a, b, color=GREY_B, sw=3):
    return Arrow(a, b, buff=0.12, color=color, stroke_width=sw, max_tip_length_to_length_ratio=0.14)


class SubsystemRundown(Scene):
    def clear_all(self):
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.4)

    def construct(self):
        self.camera.background_color = BG

        # ---- 0. TITLE ----
        t = Text("Marketing Agents Stack", weight=BOLD).scale(1.0)
        s = mono("subsystem rundown — how each package works", color=AGT, scale=0.42)
        s.next_to(t, DOWN, buff=0.3)
        self.play(Write(t))
        self.play(FadeIn(s, shift=UP * 0.3))
        self.wait(1.2)
        self.clear_all()

        # ---- 1. @mstack/core — the contract ----
        self.play(FadeIn(header("@mstack/core", CORE)))
        schemas = VGroup(*[mono(x, color=SIG, scale=0.34) for x in
                           ["Signal", "Account", "Claim", "Guideline", "Finding",
                            "Review", "Decision", "Draft", "Approval", "Outcome"]])
        schemas.arrange_in_grid(rows=5, cols=2, buff=(0.9, 0.22)).shift(LEFT * 3.0 + UP * 0.2)
        sh = Text("10 Zod schemas", color=SIG, weight=BOLD).scale(0.4).next_to(schemas, UP, buff=0.3)
        seams = VGroup(*[mono(x, color=SCO, scale=0.34) for x in
                         ["SignalSource", "EnrichmentProvider", "ScoringProvider",
                          "GuidelineCorpus", "OutreachChannel"]])
        seams.arrange(DOWN, buff=0.28).shift(RIGHT * 3.2 + UP * 0.1)
        sk = Text("5 adapter seams", color=SCO, weight=BOLD).scale(0.4).next_to(seams, UP, buff=0.3)
        self.play(FadeIn(sh), LaggedStart(*[FadeIn(m) for m in schemas], lag_ratio=0.08, run_time=1.2))
        self.play(FadeIn(sk), LaggedStart(*[FadeIn(m) for m in seams], lag_ratio=0.12, run_time=1.0))
        self.play(FadeIn(cap("one vocabulary every package imports — validates webhooks, agent output & storage")))
        self.wait(1.6)
        self.clear_all()

        # ---- 2. adapters-signals — ingest ----
        self.play(FadeIn(header("@mstack/adapters-signals", SIG)))
        raw = box('{ event:"whitepaper", company:"figma.com" }', GREY_C, w=5.4, h=0.9, tscale=0.32, mono_label=True).shift(UP * 1.4)
        srcs = VGroup(*[box(x, SIG, w=2.5, h=0.7, tscale=0.32, mono_label=True) for x in
                        ["SampleSource", "Segment", "PostHog", "GitHub"]])
        srcs.arrange(RIGHT, buff=0.3).move_to(ORIGIN)
        sigobj = box("Signal  (zod-validated)", SIG, w=4.2, h=0.9, tscale=0.36).shift(DOWN * 1.5)
        self.play(FadeIn(raw))
        self.play(LaggedStart(*[FadeIn(m, shift=UP * 0.2) for m in srcs], lag_ratio=0.15, run_time=1.0))
        self.play(*[GrowArrow(arrow(raw.get_bottom(), srcs.get_top(), SIG))],
                  GrowArrow(arrow(srcs.get_bottom(), sigobj.get_top(), SIG)), FadeIn(sigobj))
        self.play(FadeIn(cap("every source normalizes to ONE Signal atom (Segment-spec shaped)")))
        self.wait(1.5)
        self.clear_all()

        # ---- 3. memory — warehouse + hash chain ----
        self.play(FadeIn(header("@mstack/memory", MEM)))
        tables = VGroup(*[mono(x, color=MEM, scale=0.32) for x in
                          ["signals", "accounts", "reviews", "decisions", "drafts", "outcomes"]])
        tables.arrange_in_grid(rows=3, cols=2, buff=(0.9, 0.2)).shift(LEFT * 3.3 + UP * 0.1)
        tl = Text("DuckDB — one table / primitive", color=MEM, weight=BOLD).scale(0.36).next_to(tables, UP, buff=0.3)
        # hash chain
        chain = VGroup(*[box(f"appr {i}", MEM, w=1.7, h=0.7, tscale=0.3, mono_label=True) for i in (1, 2, 3)])
        chain.arrange(RIGHT, buff=0.5).shift(RIGHT * 2.6 + DOWN * 0.2)
        carr = VGroup(*[arrow(chain[i].get_right(), chain[i + 1].get_left(), MEM, 3) for i in (0, 1)])
        clbl = Text("hash-chained audit", color=MEM, weight=BOLD).scale(0.36).next_to(chain, UP, buff=0.3)
        hh = mono("hash = sha256(prevHash + data)", color=GREY_A, scale=0.3).next_to(chain, DOWN, buff=0.3)
        self.play(FadeIn(tl), LaggedStart(*[FadeIn(m) for m in tables], lag_ratio=0.1, run_time=0.9))
        self.play(FadeIn(clbl), LaggedStart(FadeIn(chain[0]), GrowArrow(carr[0]), FadeIn(chain[1]),
                                            GrowArrow(carr[1]), FadeIn(chain[2]), lag_ratio=0.4, run_time=1.4))
        self.play(FadeIn(hh))
        self.play(FadeIn(cap("every record persists & compounds; approvals are tamper-evident")))
        self.wait(1.5)
        self.clear_all()

        # ---- 4. adapters-enrichment ----
        self.play(FadeIn(header("@mstack/adapters-enrichment", ENR)))
        dom = box('domain: "figma.com"', GREY_C, w=3.4, h=0.8, tscale=0.34, mono_label=True).shift(UP * 1.4)
        provs = VGroup(
            box("sample", ENR, w=2.3, h=0.75, tscale=0.32, sub="offline", sscale=0.26),
            box("llm-web", ENR, w=2.6, h=0.75, tscale=0.32, sub="Crawl4AI + Claude", sscale=0.24),
            box("Wikidata·GLEIF·EDGAR", ENR, w=3.6, h=0.75, tscale=0.3, sub="CC0 registries", sscale=0.24),
        ).arrange(RIGHT, buff=0.35).move_to(ORIGIN)
        merged = box("mergeEnrichment  ->  record + provenance", ENR, w=6.0, h=0.9, tscale=0.34, mono_label=False).shift(DOWN * 1.5)
        self.play(FadeIn(dom))
        self.play(LaggedStart(*[FadeIn(m, shift=UP * 0.2) for m in provs], lag_ratio=0.15, run_time=1.1))
        self.play(GrowArrow(arrow(provs.get_bottom(), merged.get_top(), ENR)), FadeIn(merged))
        self.play(FadeIn(cap("trust order: registry > llm-web > paid — conflicts resolved, not averaged")))
        self.wait(1.5)
        self.clear_all()

        # ---- 5. adapters-scoring ----
        self.play(FadeIn(header("@mstack/adapters-scoring", SCO)))
        scorers = VGroup(
            box("RulesScorer", SCO, w=3.0, h=0.85, tscale=0.34, sub="weights + hard disqualifiers", sscale=0.24),
            box("ClaudeScorer", SCO, w=3.0, h=0.85, tscale=0.34, sub="cold-start + rationale", sscale=0.24),
            box("OnnxScorer", SCO, w=3.0, h=0.85, tscale=0.34, sub="scikit -> ONNX", sscale=0.24),
        ).arrange(DOWN, buff=0.3).shift(LEFT * 2.6)
        hyb = box("HybridScorer", SCO, w=3.0, h=1.5, tscale=0.42, sub="blend", sscale=0.3).shift(RIGHT * 3.0)
        out = box("Figma  76/100  ·  FIT", SCO, w=3.4, h=0.8, tscale=0.36).next_to(hyb, DOWN, buff=0.4)
        self.play(LaggedStart(*[FadeIn(m, shift=RIGHT * 0.2) for m in scorers], lag_ratio=0.2, run_time=1.1))
        self.play(*[GrowArrow(arrow(s.get_right(), hyb.get_left(), SCO)) for s in scorers], FadeIn(hyb))
        self.play(GrowArrow(arrow(hyb.get_bottom(), out.get_top(), SCO)), FadeIn(out))
        self.play(FadeIn(cap("the noise filter — a hard disqualifier can't be rescued by LLM optimism")))
        self.wait(1.5)
        self.clear_all()

        # ---- 6. agents — the mechanism ----
        self.play(FadeIn(header("@mstack/agents", AGT)))
        ra = mono("runAgent<In, Out>(cfg)", color=AGT, scale=0.5).to_edge(UP, buff=1.4)
        steps = VGroup(
            box("system + context-pack", AGT, w=4.2, h=0.7, tscale=0.34),
            box("Claude Messages API  +  tool-use loop", AGT, w=5.6, h=0.7, tscale=0.32),
            box("Zod-validate the JSON output", AGT, w=4.6, h=0.7, tscale=0.34),
            box("1 bounded re-ask on failure  ->  Out", AGT, w=5.2, h=0.7, tscale=0.32),
        ).arrange(DOWN, buff=0.28).next_to(ra, DOWN, buff=0.4)
        tools = mono("tools: retrieve · sqlQuery · enrich", color=GREY_A, scale=0.32).next_to(steps, DOWN, buff=0.3)
        self.play(Write(ra))
        self.play(LaggedStart(*[FadeIn(m, shift=DOWN * 0.15) for m in steps], lag_ratio=0.3, run_time=1.6))
        self.play(FadeIn(tools))
        self.play(FadeIn(cap("how EVERY agent calls Claude — structured output, no LangChain")))
        self.wait(1.6)
        self.clear_all()

        # ---- 7. reviewer — pipeline A ----
        self.play(FadeIn(header("@mstack/reviewer   (claim-drift review)", REV)))
        rsteps = VGroup(*[box(x, REV, w=6.4, h=0.62, tscale=0.32, mono_label=False) for x in
                          ["1  segment the asset",
                           "2  scanDeterministic  ->  priors (6 categories)",
                           "3  extract claims  (Claude)",
                           "4  LanceCorpus.retrieve  (bge-small RAG)",
                           "5  judge (Opus): supported | drifted | unsupported",
                           "6  scoreForChanges  ->  1-5 + verdict + drafts"]])
        rsteps.arrange(DOWN, buff=0.14).move_to(DOWN * 0.2)
        self.play(LaggedStart(*[FadeIn(m, shift=RIGHT * 0.2) for m in rsteps], lag_ratio=0.25, run_time=2.2))
        self.play(FadeIn(cap("deterministic rules + Claude judge — but it NEVER writes copy")))
        self.wait(1.6)
        self.clear_all()

        # ---- 8. account-intel — pipeline B ----
        self.play(FadeIn(header("@mstack/account-intel   (the swarm)", ACC)))
        resolve = box("resolveAccount  ->  Account + provenance", ACC, w=6.2, h=0.7, tscale=0.32).shift(UP * 1.6)
        rank = box("rankAccounts  (scoring noise filter)", ACC, w=5.4, h=0.7, tscale=0.32).next_to(resolve, DOWN, buff=0.3)
        swarm = VGroup(
            box("SDR-Researcher", AGT, w=2.9, h=0.75, tscale=0.3, sub="cites real signalIds", sscale=0.22),
            box("Copywriter", AGT, w=2.5, h=0.75, tscale=0.32),
            box("GTM-Router", AGT, w=2.6, h=0.75, tscale=0.32),
        ).arrange(RIGHT, buff=0.35).next_to(rank, DOWN, buff=0.35)
        swa = VGroup(arrow(swarm[0].get_right(), swarm[1].get_left(), GREY_B),
                     arrow(swarm[1].get_right(), swarm[2].get_left(), GREY_B))
        dec = box("Decision + pending Draft", ACC, w=4.4, h=0.7, tscale=0.34).next_to(swarm, DOWN, buff=0.35)
        self.play(FadeIn(resolve))
        self.play(GrowArrow(arrow(resolve.get_bottom(), rank.get_top(), ACC)), FadeIn(rank))
        self.play(LaggedStart(FadeIn(swarm[0]), GrowArrow(swa[0]), FadeIn(swarm[1]),
                              GrowArrow(swa[1]), FadeIn(swarm[2]), lag_ratio=0.35, run_time=1.6))
        self.play(GrowArrow(arrow(swarm.get_bottom(), dec.get_top(), ACC)), FadeIn(dec))
        self.play(FadeIn(cap("signals -> reasoning -> next-best-action -> a draft (never auto-sent)")))
        self.wait(1.5)
        self.clear_all()

        # ---- 9. credentials — gatecraft ----
        self.play(FadeIn(header("@mstack/credentials   (gatecraft broker)", CRED)))
        prov = box("provider", CRED, w=3.0, h=1.5, tscale=0.4, sub="proxyCall() only", sscale=0.3).shift(LEFT * 2.8)
        no = mono("no resolve()  ·  never sees the key", color=RED, scale=0.34).next_to(prov, DOWN, buff=0.3)
        broker = box("broker", CRED, w=2.6, h=1.5, tscale=0.4, sub="injects at call time", sscale=0.28).shift(RIGHT * 1.2)
        api = box("external API", GREY_C, w=2.6, h=1.0, tscale=0.34).shift(RIGHT * 4.6)
        self.play(FadeIn(prov), FadeIn(no))
        self.play(GrowArrow(arrow(prov.get_right(), broker.get_left(), CRED)), FadeIn(broker))
        self.play(GrowArrow(arrow(broker.get_right(), api.get_left(), CRED)), FadeIn(api))
        self.play(FadeIn(cap("credentials never enter agent context — the broker makes the call")))
        self.wait(1.5)
        self.clear_all()

        # ---- 10. runtime — the gate ----
        self.play(FadeIn(header("@mstack/runtime   (draft-first gate)", RUN)))
        sm = VGroup(box("pending", GREY_C, w=2.2, h=0.8, tscale=0.36),
                    box("approved", RUN, w=2.2, h=0.8, tscale=0.36),
                    box("dispatched", AGT, w=2.4, h=0.8, tscale=0.36)).arrange(RIGHT, buff=1.2).shift(UP * 1.1)
        a1 = arrow(sm[0].get_right(), sm[1].get_left(), RUN)
        a2 = arrow(sm[1].get_right(), sm[2].get_left(), AGT)
        l1 = mono("appendApproval", color=GREY_A, scale=0.28).next_to(a1, UP, buff=0.12)
        l2 = mono("dispatchDraft", color=GREY_A, scale=0.28).next_to(a2, UP, buff=0.12)
        chk = Paragraph("assertDispatchable:", "re-reads the PERSISTED draft +",
                        "verifies a real hash-chained Approval", alignment="center", color=GREY_A).scale(0.34)
        chk.shift(DOWN * 1.4)
        self.play(FadeIn(sm[0]))
        self.play(GrowArrow(a1), FadeIn(l1), FadeIn(sm[1]))
        self.play(GrowArrow(a2), FadeIn(l2), FadeIn(sm[2]))
        self.play(FadeIn(chk))
        self.play(FadeIn(cap("dispatch.ts is the ONE send path — no send without a signed approval")))
        self.wait(1.7)
        self.clear_all()

        # ---- 11. apps ----
        self.play(FadeIn(header("apps/  —  the surfaces", APP)))
        apps = VGroup(
            box("mstack CLI", APP, w=3.2, h=1.1, tscale=0.4, sub="seed · demo · approve", sscale=0.26),
            box("Portal", SIG, w=3.0, h=1.1, tscale=0.4, sub="content review UI", sscale=0.26),
            box("Console", ACC, w=3.0, h=1.1, tscale=0.4, sub="activation UI", sscale=0.26),
        ).arrange(RIGHT, buff=0.5).move_to(ORIGIN)
        self.play(LaggedStart(*[FadeIn(m, shift=UP * 0.2) for m in apps], lag_ratio=0.25, run_time=1.2))
        self.play(FadeIn(cap("offline (deterministic) with no key · live wires the real Claude agents")))
        self.wait(1.5)
        self.clear_all()

        # ---- 12. CLOSE ----
        c1 = Text("Swap any sample -> real behind a seam.", weight=BOLD).scale(0.6)
        c2 = mono("12 packages · ~280 tests · the whole loop runs offline", color=AGT, scale=0.4)
        c2.next_to(c1, DOWN, buff=0.4)
        self.play(Write(c1))
        self.play(FadeIn(c2, shift=UP * 0.2))
        self.wait(2.0)
        self.play(*[FadeOut(m) for m in self.mobjects])
