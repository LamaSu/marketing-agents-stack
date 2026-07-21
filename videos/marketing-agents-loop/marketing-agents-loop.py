"""How the Marketing Agents Stack works — signal -> decision -> action -> memory.

Plain Manim CE (no LaTeX; every label is Text/Paragraph). Dark palette to match
the SignalSphere console. Render:
  python .../scripts/render.py --scene marketing-agents-loop.py --quality l
"""
from manim import *

BG = "#0d1117"
SIG = BLUE
DEC = TEAL
ACT = GOLD
MEM = PURPLE
AGENT = "#7ee787"  # soft green accent


def card(label, sub, color, w=2.9, h=1.45, tscale=0.5, sscale=0.3):
    box = RoundedRectangle(width=w, height=h, corner_radius=0.18,
                           color=color, fill_color=color, fill_opacity=0.16, stroke_width=3)
    t = Text(label, color=WHITE, weight=BOLD).scale(tscale)
    parts = [t]
    if sub:
        s = Text(sub, color=GREY_B).scale(sscale)
        parts.append(s)
    inner = VGroup(*parts).arrange(DOWN, buff=0.12).move_to(box.get_center())
    return VGroup(box, inner)


class MarketingAgentsLoop(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. TITLE ----------
        title = Text("Marketing Agents Stack", weight=BOLD).scale(1.05)
        tagline = Text("signal  ->  decision  ->  action  ->  memory", color=TEAL).scale(0.5)
        tagline.next_to(title, DOWN, buff=0.3)
        self.play(Write(title))
        self.play(FadeIn(tagline, shift=UP * 0.3))
        self.wait(1.3)
        self.play(FadeOut(title), FadeOut(tagline))

        # ---------- 2. THE GAP ----------
        gap_h = Text("The Signal-to-Decision Gap", weight=BOLD, color=GOLD).scale(0.8).to_edge(UP, buff=0.7)
        self.play(Write(gap_h))

        sources = VGroup(*[Text(s, color=GREY_A).scale(0.34) for s in
                           ["Marketo", "LinkedIn", "RollWorks", "Outreach", "Salesforce"]])
        sources.arrange(DOWN, buff=0.22).to_edge(LEFT, buff=1.0)
        captured = card("Intent captured", "tons of signal", SIG, w=3.0, h=1.3).move_to(ORIGIN + LEFT * 0.2)
        action = card("Timely action", "too slow / too late", GREY_C, w=3.0, h=1.3).to_edge(RIGHT, buff=1.0)

        s_arrows = VGroup(*[Arrow(src.get_right(), captured.get_left(), buff=0.2,
                                  color=GREY_B, stroke_width=2, max_tip_length_to_length_ratio=0.12)
                            for src in sources])
        self.play(LaggedStart(*[FadeIn(s) for s in sources], lag_ratio=0.15, run_time=1.0))
        self.play(Create(captured), *[GrowArrow(a) for a in s_arrows], run_time=0.9)
        gap_arrow = Arrow(captured.get_right(), action.get_left(), buff=0.25, color=RED, stroke_width=5)
        qmark = Text("?", color=RED, weight=BOLD).scale(0.7).next_to(gap_arrow, UP, buff=0.1)
        self.play(GrowArrow(gap_arrow), FadeIn(action), FadeIn(qmark))
        cap2 = Text("captures intent — but can't convert it into timely action",
                    color=GREY_A).scale(0.42).to_edge(DOWN, buff=0.8)
        self.play(Write(cap2))
        self.wait(1.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 3. THE INSIGHT ----------
        ins_h = Text("Two demos — one loop", weight=BOLD).scale(0.8).to_edge(UP, buff=0.7)
        self.play(Write(ins_h))
        demoA = card("Anthropic reviewer", "brand-safe content", SIG, w=4.0, h=1.4).shift(LEFT * 3.2)
        demoB = card("Signals -> outreach", "activate accounts", ACT, w=4.0, h=1.4).shift(RIGHT * 3.2)
        self.play(FadeIn(demoA, shift=RIGHT * 0.4), FadeIn(demoB, shift=LEFT * 0.4))
        self.wait(0.8)
        self.play(demoA.animate.move_to(LEFT * 1.7), demoB.animate.move_to(RIGHT * 1.7))
        merged = Text("two halves of ONE loop", color=AGENT, weight=BOLD).scale(0.6).to_edge(DOWN, buff=1.2)
        self.play(Write(merged))
        self.wait(1.3)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 4. THE LOOP (hero) ----------
        loop_h = Text("The loop", weight=BOLD).scale(0.7).to_edge(UP, buff=0.5)
        self.play(FadeIn(loop_h))
        n_sig = card("SIGNAL", "SignalSource", SIG)
        n_dec = card("DECIDE", "context + score + agents", DEC)
        n_act = card("ACT", "draft-first + human gate", ACT)
        n_mem = card("MEMORY", "DuckDB + hash-chain", MEM)
        row = VGroup(n_sig, n_dec, n_act, n_mem).arrange(RIGHT, buff=0.5).move_to(UP * 0.55)

        arrows = VGroup()
        for a, b in [(n_sig, n_dec), (n_dec, n_act), (n_act, n_mem)]:
            arrows.add(Arrow(a.get_right(), b.get_left(), buff=0.12, color=WHITE, stroke_width=3))
        ret = CurvedArrow(n_mem.get_bottom() + DOWN * 0.05, n_sig.get_bottom() + DOWN * 0.05,
                          color=MEM, angle=-PI * 0.55)
        ret_lbl = Text("outcome feeds the next run — it compounds", color=GREY_B).scale(0.36)
        ret_lbl.next_to(ret, DOWN, buff=0.05)

        for n in (n_sig, n_dec, n_act, n_mem):
            self.play(FadeIn(n, shift=UP * 0.2), run_time=0.45)
        self.play(*[GrowArrow(a) for a in arrows], run_time=0.6)
        self.play(Create(ret), FadeIn(ret_lbl), run_time=0.8)

        # a token travels the ring
        token = Dot(color=AGENT, radius=0.12).move_to(n_sig.get_top())
        self.play(FadeIn(token))
        for n in (n_sig, n_dec, n_act, n_mem):
            self.play(token.animate.move_to(n.get_center()), Indicate(n, color=AGENT, scale_factor=1.08), run_time=0.55)
        self.play(MoveAlongPath(token, ret), run_time=1.0)
        self.play(token.animate.move_to(n_sig.get_center()), run_time=0.4)
        self.play(FadeOut(token))
        self.wait(0.8)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 5. INSIDE DECIDE ----------
        dec_h = Text("Inside DECIDE — two Claude agents", weight=BOLD, color=DEC).scale(0.62).to_edge(UP, buff=0.6)
        self.play(Write(dec_h))
        reviewer = card("Claim-Drift Reviewer", "score 1-5  •  6 drift categories", SIG, w=5.4, h=1.5, tscale=0.5)
        reviewer.shift(UP * 1.3)
        self.play(FadeIn(reviewer, shift=DOWN * 0.2))
        rnote = Text("reviews & flags — never writes copy", color=GREY_B).scale(0.34).next_to(reviewer, DOWN, buff=0.18)
        self.play(FadeIn(rnote))
        self.wait(0.6)

        swarm_title = Text("Account-Intel swarm", color=ACT, weight=BOLD).scale(0.5).shift(DOWN * 0.4)
        w1 = card("SDR-Researcher", "", AGENT, w=3.0, h=0.95, tscale=0.4)
        w2 = card("Copywriter", "", AGENT, w=2.6, h=0.95, tscale=0.4)
        w3 = card("GTM-Router", "", AGENT, w=2.6, h=0.95, tscale=0.4)
        workers = VGroup(w1, w2, w3).arrange(RIGHT, buff=0.5).next_to(swarm_title, DOWN, buff=0.3)
        wa = VGroup(Arrow(w1.get_right(), w2.get_left(), buff=0.1, color=GREY_B, stroke_width=3),
                    Arrow(w2.get_right(), w3.get_left(), buff=0.1, color=GREY_B, stroke_width=3))
        self.play(Write(swarm_title))
        self.play(LaggedStart(FadeIn(w1), GrowArrow(wa[0]), FadeIn(w2), GrowArrow(wa[1]), FadeIn(w3),
                              lag_ratio=0.4, run_time=1.6))
        out = Text("-> personalized outreach draft (pending)", color=GREY_A).scale(0.36).to_edge(DOWN, buff=0.6)
        self.play(FadeIn(out))
        self.wait(1.4)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 6. GUARDRAILS ----------
        g_h = Text("3 guardrails — mechanical, not hopeful", weight=BOLD).scale(0.62).to_edge(UP, buff=0.7)
        self.play(Write(g_h))

        def guard(t, s, color):
            box = RoundedRectangle(width=3.9, height=2.1, corner_radius=0.18, color=color,
                                   fill_color=color, fill_opacity=0.14, stroke_width=3)
            head = Text(t, color=color, weight=BOLD).scale(0.42)
            body = Paragraph(*s, alignment="center", color=GREY_A).scale(0.32)
            body.set(width=3.4)
            inner = VGroup(head, body).arrange(DOWN, buff=0.28).move_to(box.get_center())
            return VGroup(box, inner)

        g1 = guard("reviewer != generator", ["the review schema has", "no field for prose", "— it's a type"], SIG)
        g2 = guard("human approves", ["one gated dispatch path;", "no send without a", "signed approval"], ACT)
        g3 = guard("keep every record", ["signals, decisions,", "approvals — all persist", "and compound"], MEM)
        cards = VGroup(g1, g2, g3).arrange(RIGHT, buff=0.5).move_to(DOWN * 0.3)
        self.play(LaggedStart(*[FadeIn(g, shift=UP * 0.3) for g in cards], lag_ratio=0.35, run_time=1.6))
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 7. CLOSE ----------
        c1 = Text("Open  •  Offline-first  •  Claude-native", weight=BOLD).scale(0.7)
        c2 = Text("on the chorus runtime + gatecraft credential broker", color=TEAL).scale(0.44)
        c2.next_to(c1, DOWN, buff=0.3)
        c3 = Text("14 packages  •  ~280 tests  •  the whole loop runs offline", color=GREY_A).scale(0.42)
        c3.next_to(c2, DOWN, buff=0.5)
        self.play(Write(c1))
        self.play(FadeIn(c2, shift=UP * 0.2))
        self.play(FadeIn(c3, shift=UP * 0.2))
        self.wait(2.0)
        self.play(*[FadeOut(m) for m in self.mobjects])
