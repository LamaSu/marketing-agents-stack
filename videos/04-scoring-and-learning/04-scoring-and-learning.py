"""How an account gets scored -- and how the approval queue becomes the training set.

Plain Manim CE (no LaTeX; every label is Text). Dark palette to match the
SignalSphere console / the house style set by
videos/marketing-agents-loop/marketing-agents-loop.py. Render:
  python .../scripts/render.py --scene 04-scoring-and-learning.py --quality l

Facts verified against packages/adapters-scoring/src/{rules-scorer,hybrid-scorer,
qualifier,onnx-scorer,tiers}.ts and packages/adapters-scoring/train/calibrate.py --
see brief.md for the beat-by-beat mapping.
"""
from manim import *

BG = "#0d1117"
SIG = BLUE          # RulesScorer / the "fit" axis
DEC = TEAL          # calibration / tier bands
ACT = GOLD          # human approval queue / the gate
MEM = PURPLE        # GaussianProcessQualifier / the learning loop
AGENT = "#7ee787"   # Claude cold-start scorer (soft green, matches house style)
INTENT = ORANGE     # the "intent" axis (time-decayed signals)


def card(label, sub, color, w=2.9, h=1.45, tscale=0.5, sscale=0.3):
    box = RoundedRectangle(width=w, height=h, corner_radius=0.18,
                           color=color, fill_color=color, fill_opacity=0.16, stroke_width=3)
    parts = [Text(label, color=WHITE, weight=BOLD).scale(tscale)]
    if sub:
        parts.append(Text(sub, color=GREY_B).scale(sscale))
    inner = VGroup(*parts).arrange(DOWN, buff=0.12).move_to(box.get_center())
    return VGroup(box, inner)


def fit_width(mobj, max_w=13.2):
    """Defensive width cap -- this scene is authored without a render pass, so any
    standalone header/caption gets scaled down if it would exceed the safe frame
    width instead of trusting a hand-estimated font scale."""
    if mobj.width > max_w:
        mobj.scale_to_fit_width(max_w)
    return mobj


class ScoringAndLearning(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. HOOK ----------
        h1 = fit_width(Text("A score only matters if it does two things", weight=BOLD).scale(0.62))
        h2a = Text("drives an action", color=ACT, weight=BOLD).scale(0.6)
        plus = Text("+", color=GREY_B).scale(0.55)
        h2b = Text("gets better over time", color=MEM, weight=BOLD).scale(0.6)
        h2 = fit_width(VGroup(h2a, plus, h2b).arrange(RIGHT, buff=0.3))
        VGroup(h1, h2).arrange(DOWN, buff=0.5).move_to(UP * 0.3)
        self.play(Write(h1))
        self.play(FadeIn(h2, shift=UP * 0.2))
        self.wait(1.2)
        sub = fit_width(Text("here's both, inside the Marketing Agents Stack", color=GREY_A).scale(0.4))
        sub.next_to(h2, DOWN, buff=0.6)
        self.play(FadeIn(sub))
        self.wait(1.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 2. THE BLEND (HybridScorer) ----------
        b_h = fit_width(Text("HybridScorer -- a blend, not a vote", weight=BOLD).scale(0.62))
        b_h.to_edge(UP, buff=0.6)
        self.play(Write(b_h))

        c_rules = card("RulesScorer", "the deterministic floor", SIG, w=3.6, h=1.35, tscale=0.42, sscale=0.28)
        c_claude = card("Claude (optional)", "the rationale", AGENT, w=3.6, h=1.35, tscale=0.4, sscale=0.28)
        c_onnx = card("ONNX (optional)", "the probability", MEM, w=3.6, h=1.35, tscale=0.4, sscale=0.28)
        row2 = VGroup(c_rules, c_claude, c_onnx).arrange(RIGHT, buff=0.4).move_to(UP * 1.6)
        self.play(LaggedStart(*[FadeIn(c, shift=DOWN * 0.2) for c in row2], lag_ratio=0.25, run_time=1.2))
        self.wait(0.5)

        blended = card("blended score", "max(rules, weighted(onnx, claude))", WHITE, w=7.6, h=1.3, tscale=0.42, sscale=0.3)
        blended.move_to(DOWN * 0.5)
        arrows2 = VGroup(*[Arrow(c.get_bottom(), blended.get_top(), buff=0.15, color=GREY_B, stroke_width=3) for c in row2])
        self.play(*[GrowArrow(a) for a in arrows2], FadeIn(blended), run_time=0.9)
        note2 = fit_width(Text("claude + onnx are optional; rules always runs and never fails", color=GREY_A).scale(0.34))
        note2.next_to(blended, DOWN, buff=0.3)
        self.play(FadeIn(note2))
        self.wait(1.7)
        self.play(FadeOut(row2), FadeOut(arrows2), FadeOut(blended), FadeOut(note2))

        sig_card = card("signal: unsubscribed", "", RED, w=4.3, h=1.1, tscale=0.38, sscale=0.26)
        sig_card.move_to(LEFT * 3.3 + UP * 0.6)
        result_card = card("score = 0", "DISQUALIFIED (hard floor)", RED, w=4.3, h=1.3, tscale=0.48, sscale=0.3)
        result_card.move_to(RIGHT * 3.0 + UP * 0.6)
        arrow_dq = Arrow(sig_card.get_right(), result_card.get_left(), buff=0.2, color=RED, stroke_width=5)
        skip_label = fit_width(Text("bypasses onnx + claude entirely", color=GREY_B).scale(0.32))
        skip_label.next_to(arrow_dq, UP, buff=0.12)
        self.play(FadeIn(sig_card))
        self.play(GrowArrow(arrow_dq), FadeIn(skip_label))
        self.play(FadeIn(result_card))
        capdq = fit_width(Text("an optimistic onnx or claude score can never rescue it", color=GREY_A).scale(0.36))
        capdq.to_edge(DOWN, buff=0.6)
        self.play(Write(capdq))
        self.wait(1.9)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 3. FIT x INTENT (time decay) ----------
        f_h = fit_width(Text("fit x intent -- the MadKudu-shaped split", weight=BOLD).scale(0.62))
        f_h.to_edge(UP, buff=0.6)
        self.play(Write(f_h))

        fit_card = card("FIT", "firmographic + technographic", SIG, w=5.2, h=1.4, tscale=0.55, sscale=0.3)
        intent_card = card("INTENT", "behavioral, time-decayed", INTENT, w=5.2, h=1.4, tscale=0.55, sscale=0.3)
        cols = VGroup(fit_card, intent_card).arrange(RIGHT, buff=0.7).move_to(UP * 1.9)
        fit_sub = fit_width(Text("company size, industry, region, tech", color=GREY_B).scale(0.28))
        fit_sub.next_to(fit_card, DOWN, buff=0.18)
        intent_sub = fit_width(Text("signal volume, channels, high-intent actions", color=GREY_B).scale(0.28))
        intent_sub.next_to(intent_card, DOWN, buff=0.18)
        self.play(FadeIn(fit_card, shift=RIGHT * 0.3), FadeIn(intent_card, shift=LEFT * 0.3))
        self.play(FadeIn(fit_sub), FadeIn(intent_sub))
        self.wait(1.0)

        decay_formula = fit_width(Text("weight = 0.5^(age / 90 days)", color=INTENT, weight=BOLD).scale(0.5))
        decay_formula.move_to(DOWN * 0.7)
        self.play(Write(decay_formula))
        self.wait(0.8)

        fresh_bar = Rectangle(width=1.1, height=1.5, color=INTENT, fill_color=INTENT, fill_opacity=0.7, stroke_width=2)
        stale_bar = Rectangle(width=1.1, height=0.38, color=INTENT, fill_color=INTENT, fill_opacity=0.35, stroke_width=2)
        bars = VGroup(fresh_bar, stale_bar).arrange(RIGHT, buff=1.8, aligned_edge=DOWN)
        bars.next_to(decay_formula, DOWN, buff=0.4)
        fresh_lbl = Text("2 days old -> weight 0.98", color=WHITE).scale(0.26).next_to(fresh_bar, UP, buff=0.12)
        stale_lbl = Text("6 months old -> weight 0.25", color=WHITE).scale(0.26).next_to(stale_bar, UP, buff=0.12)
        self.play(Create(fresh_bar), Create(stale_bar))
        self.play(FadeIn(fresh_lbl), FadeIn(stale_lbl))
        cap3 = fit_width(Text("same rule, same signal -- just weighted by how stale it is", color=GREY_A).scale(0.34))
        cap3.to_edge(DOWN, buff=0.4)
        self.play(FadeIn(cap3))
        self.wait(2.0)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 4. CALIBRATION ----------
        c_h = fit_width(Text("calibration -- 0.8 isn't a probability", weight=BOLD).scale(0.62))
        c_h.to_edge(UP, buff=0.6)
        self.play(Write(c_h))

        raw = card("raw score: 0.8", "just a classifier output", GREY_C, w=4.0, h=1.4, tscale=0.4, sscale=0.26)
        sidecar = card("train-time sidecar", "isotonic or Platt scaling", DEC, w=4.4, h=1.5, tscale=0.4, sscale=0.26)
        runtime = card("TypeScript inference", "OnnxScorer, unchanged", MEM, w=4.4, h=1.4, tscale=0.4, sscale=0.26)
        pipe = VGroup(raw, sidecar, runtime).arrange(RIGHT, buff=0.35).move_to(UP * 1.5)
        arrows4 = VGroup(*[Arrow(pipe[i].get_right(), pipe[i + 1].get_left(), buff=0.1, color=WHITE, stroke_width=3) for i in range(2)])
        self.play(LaggedStart(FadeIn(raw), GrowArrow(arrows4[0]), FadeIn(sidecar), GrowArrow(arrows4[1]), FadeIn(runtime),
                              lag_ratio=0.35, run_time=1.6))
        note4 = fit_width(Text("fit calibration in Python, export ONNX -- inference stays TypeScript", color=GREY_A).scale(0.34))
        note4.next_to(pipe, DOWN, buff=0.4)
        self.play(FadeIn(note4))
        self.wait(1.4)

        # tier number-line (tiers.ts: partialFit=25, fit=50, strongFit=75)
        line = Line(LEFT * 5, RIGHT * 5, color=GREY_B, stroke_width=3).move_to(DOWN * 1.4)
        start, end = line.get_start(), line.get_end()

        def pt(p):
            return start + (end - start) * p

        ticks = VGroup(*[Line(UP * 0.12, DOWN * 0.12, color=GREY_B, stroke_width=3).move_to(pt(p))
                         for p in (0, 0.25, 0.5, 0.75, 1.0)])
        tick_labels = VGroup(*[Text(str(v), color=GREY_B).scale(0.24).next_to(ticks[i], DOWN, buff=0.1)
                               for i, v in enumerate([0, 25, 50, 75, 100])])
        band_labels = VGroup(
            Text("DISQUALIFIED", color=RED).scale(0.24).move_to(pt(0.125) + UP * 0.35),
            Text("PARTIAL_FIT", color=GREY_A).scale(0.24).move_to(pt(0.375) + UP * 0.35),
            Text("FIT", color=INTENT).scale(0.24).move_to(pt(0.625) + UP * 0.35),
            Text("STRONG_FIT", color=AGENT).scale(0.24).move_to(pt(0.875) + UP * 0.35),
        )
        self.play(Create(line), Create(ticks), FadeIn(tick_labels))
        self.play(FadeIn(band_labels))
        cap4 = fit_width(Text("bands become honest once the score is calibrated", color=GREY_A).scale(0.34))
        cap4.to_edge(DOWN, buff=0.4)
        self.play(FadeIn(cap4))
        self.wait(2.1)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 5. THE LEARNING LOOP (hero) ----------
        l_h = fit_width(Text("the learning loop", weight=BOLD, color=MEM).scale(0.7))
        l_h.to_edge(UP, buff=0.6)
        self.play(FadeIn(l_h))

        n_pred = card("PREDICT", "GP: mean + uncertainty", MEM, w=3.0, h=1.4, tscale=0.4, sscale=0.24)
        n_queue = card("QUEUE", "BALD picks the most unsure", ACT, w=3.0, h=1.4, tscale=0.4, sscale=0.24)
        n_human = card("HUMAN", "approve / reject", ACT, w=3.0, h=1.4, tscale=0.4, sscale=0.24)
        n_label = card("LABEL", "decision -> refit", MEM, w=3.0, h=1.4, tscale=0.4, sscale=0.24)
        row5 = VGroup(n_pred, n_queue, n_human, n_label).arrange(RIGHT, buff=0.45).move_to(UP * 0.7)

        arrows5 = VGroup()
        for a, b in [(n_pred, n_queue), (n_queue, n_human), (n_human, n_label)]:
            arrows5.add(Arrow(a.get_right(), b.get_left(), buff=0.12, color=WHITE, stroke_width=3))
        ret5 = CurvedArrow(n_label.get_bottom() + DOWN * 0.05, n_pred.get_bottom() + DOWN * 0.05, color=MEM, angle=-PI * 0.55)
        ret5_lbl = fit_width(Text("uncertainty shrinks with every label", color=GREY_B).scale(0.32))
        ret5_lbl.next_to(ret5, DOWN, buff=0.1)

        for n in (n_pred, n_queue, n_human, n_label):
            self.play(FadeIn(n, shift=UP * 0.2), run_time=0.4)
        self.play(*[GrowArrow(a) for a in arrows5], run_time=0.6)
        self.play(Create(ret5), FadeIn(ret5_lbl), run_time=0.8)

        counter = fit_width(Text("uncertain accounts: 12", color=GREY_A).scale(0.36))
        counter.to_edge(DOWN, buff=0.45)
        self.play(FadeIn(counter))
        self.wait(0.5)

        token = Dot(color=AGENT, radius=0.12).move_to(n_pred.get_top())
        self.play(FadeIn(token))
        for n in (n_pred, n_queue, n_human, n_label):
            self.play(token.animate.move_to(n.get_center()), Indicate(n, color=AGENT, scale_factor=1.08), run_time=0.5)
        self.play(MoveAlongPath(token, ret5), run_time=1.0)
        self.play(token.animate.move_to(n_pred.get_center()), run_time=0.35)

        counter2 = fit_width(Text("uncertain accounts: 4", color=AGENT).scale(0.36)).move_to(counter.get_center())
        self.play(ReplacementTransform(counter, counter2), FadeOut(token))
        self.wait(2.3)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 6. COLD START ----------
        cs_h = fit_width(Text("cold start is correct, not broken", weight=BOLD).scale(0.62))
        cs_h.to_edge(UP, buff=0.7)
        self.play(Write(cs_h))

        dots = VGroup(*[Dot(color=MEM, radius=0.22, fill_opacity=0.5) for _ in range(5)])
        dots.arrange(RIGHT, buff=1.0).move_to(UP * 1.2)
        qmarks = VGroup(*[Text("?", color=WHITE, weight=BOLD).scale(0.4).move_to(d.get_center()) for d in dots])
        zero_label = fit_width(Text("zero labels -> posterior = the prior -> uniform high uncertainty", color=GREY_A).scale(0.36))
        zero_label.next_to(dots, DOWN, buff=0.4)
        self.play(LaggedStart(*[FadeIn(d) for d in dots], lag_ratio=0.15, run_time=0.9))
        self.play(FadeIn(qmarks))
        self.play(FadeIn(zero_label))
        self.wait(1.0)

        human_card = card("human review", "everything routes here", ACT, w=4.4, h=1.3, tscale=0.42, sscale=0.28)
        human_card.move_to(DOWN * 1.7)
        arrows6 = VGroup(*[Arrow(d.get_bottom(), human_card.get_top(), buff=0.15, color=GREY_B, stroke_width=2.5) for d in dots])
        self.play(*[GrowArrow(a) for a in arrows6], FadeIn(human_card), run_time=1.0)
        cap6 = fit_width(Text("exactly right when the model knows nothing yet", color=GREY_A).scale(0.36))
        cap6.to_edge(DOWN, buff=0.4)
        self.play(FadeIn(cap6))
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 7. CLOSE ----------
        c1 = fit_width(Text("The gate and the learner are the same loop.", weight=BOLD).scale(0.66))
        c2 = fit_width(Text("RulesScorer -> HybridScorer -> GaussianProcessQualifier", color=TEAL).scale(0.4))
        c2.next_to(c1, DOWN, buff=0.35)
        c3 = fit_width(Text("offline  •  deterministic  •  every human approval is a training label", color=GREY_A).scale(0.36))
        c3.next_to(c2, DOWN, buff=0.4)
        self.play(Write(c1))
        self.play(FadeIn(c2, shift=UP * 0.2))
        self.play(FadeIn(c3, shift=UP * 0.2))
        self.wait(3.3)
        self.play(*[FadeOut(m) for m in self.mobjects])
