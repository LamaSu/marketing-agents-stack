"""Sequences & analytics — multi-step cadences that still can't send, and the
funnel that proves what worked.

Plain Manim CE (no LaTeX; every label is Text/Paragraph). Matches the dark
palette + card() vocabulary of marketing-agents-loop.py. Render:
  python .../scripts/render.py --scene 05-sequences-and-analytics.py --quality l
"""
from manim import *

BG = "#0d1117"
SIG = BLUE         # signals / sequence steps
DEC = TEAL         # executor / durable-wait seam
ACT = GOLD         # action / pending draft
MEM = PURPLE       # memory / analytics
AGENT = "#7ee787"  # soft green accent — human gate
STOP = RED         # auto-send contrast / stopped run
CRM = ORANGE       # CRM delivery


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


def chip(label, color, w=2.4, h=0.62, tscale=0.32):
    box = RoundedRectangle(width=w, height=h, corner_radius=0.31, color=color,
                           fill_color=color, fill_opacity=0.24, stroke_width=2.5)
    t = Text(label, color=WHITE, weight=BOLD).scale(tscale).move_to(box.get_center())
    return VGroup(box, t)


class SequencesAndAnalytics(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. HOOK (~8.5s) ----------
        h1 = Text("One-off sends aren't a GTM motion", weight=BOLD).scale(0.66)
        h1.to_edge(UP, buff=0.9)
        self.play(Write(h1), run_time=1.2)
        self.wait(0.5)

        need = Text("you need CADENCES", color=GOLD, weight=BOLD).scale(0.55)
        need.next_to(h1, DOWN, buff=0.5)
        self.play(FadeIn(need, shift=UP * 0.2), run_time=0.7)
        self.wait(0.3)

        c1 = chip("Outreach", GREY_C, w=2.6)
        c2 = chip("Salesloft", GREY_C, w=2.6)
        sells = VGroup(c1, c2).arrange(RIGHT, buff=0.6).next_to(need, DOWN, buff=0.6)
        sell_lbl = Text("that's what they sell", color=GREY_B).scale(0.36).next_to(sells, DOWN, buff=0.3)
        self.play(LaggedStart(FadeIn(c1), FadeIn(c2), lag_ratio=0.35), run_time=0.8)
        self.play(FadeIn(sell_lbl), run_time=0.5)
        self.wait(0.8)

        gate_note = Text("here's that — with the gate intact", color=AGENT, weight=BOLD).scale(0.48)
        gate_note.to_edge(DOWN, buff=0.9)
        self.play(Write(gate_note), run_time=1.2)
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.7)

        # ---------- 2. A SEQUENCE (~8.5s) ----------
        s_h = Text("A Sequence — ordered, timed steps", weight=BOLD, color=SIG).scale(0.6).to_edge(UP, buff=0.7)
        self.play(Write(s_h), run_time=1.1)

        cmd = Text("mstack sequence start figma.com", color=GREEN).scale(0.38)
        cmd.next_to(s_h, DOWN, buff=0.45)
        self.play(FadeIn(cmd, shift=DOWN * 0.1), run_time=0.6)
        self.wait(0.5)

        step1 = card("Step 1 — opener", "day 0  •  stopIfReplied", SIG, w=4.3, h=1.3, tscale=0.42, sscale=0.28)
        step2 = card("Step 2 — follow-up", "day 3  •  stopIfReplied", SIG, w=4.3, h=1.3, tscale=0.42, sscale=0.28)
        steps = VGroup(step1, step2).arrange(RIGHT, buff=0.7).move_to(DOWN * 0.5)
        arrow12 = Arrow(step1.get_right(), step2.get_left(), buff=0.15, color=WHITE, stroke_width=3)
        self.play(FadeIn(step1, shift=UP * 0.2), run_time=0.6)
        self.play(GrowArrow(arrow12), FadeIn(step2, shift=UP * 0.2), run_time=0.6)
        self.wait(0.4)

        acct = card("figma.com", "enrolling", AGENT, w=2.3, h=0.95, tscale=0.38, sscale=0.26)
        acct.next_to(step1, UP, buff=0.7).align_to(step1, LEFT)
        enroll_arrow = Arrow(acct.get_bottom(), step1.get_top(), buff=0.12, color=AGENT, stroke_width=3)
        self.play(FadeIn(acct), GrowArrow(enroll_arrow), run_time=0.7)
        self.play(Indicate(step1, color=AGENT, scale_factor=1.06), run_time=0.5)
        self.play(Indicate(step2, color=AGENT, scale_factor=1.06), run_time=0.5)
        self.wait(2.3)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.7)

        # ---------- 3. THE CRITICAL DIFFERENCE (hero, ~13s) ----------
        d_h = Text("The critical difference", weight=BOLD, color=ACT).scale(0.66).to_edge(UP, buff=0.6)
        self.play(Write(d_h), run_time=1.2)

        left_lbl = Text("Outreach / Salesloft", color=GREY_B).scale(0.38).move_to(LEFT * 3.4 + UP * 2.1)
        right_lbl = Text("mstack sequences", color=GREY_B).scale(0.38).move_to(RIGHT * 3.4 + UP * 2.1)
        self.play(FadeIn(left_lbl), FadeIn(right_lbl), run_time=0.6)

        l_step = card("step due", "", GREY_C, w=2.5, h=0.85, tscale=0.34).move_to(LEFT * 3.4 + UP * 1.15)
        r_step = card("step due", "", GREY_C, w=2.5, h=0.85, tscale=0.34).move_to(RIGHT * 3.4 + UP * 1.15)
        self.play(FadeIn(l_step), FadeIn(r_step), run_time=0.6)
        self.wait(0.4)

        l_arrow = Arrow(l_step.get_bottom(), l_step.get_bottom() + DOWN * 0.9, buff=0.08, color=STOP, stroke_width=4)
        r_arrow = Arrow(r_step.get_bottom(), r_step.get_bottom() + DOWN * 0.9, buff=0.08, color=ACT, stroke_width=4)
        self.play(GrowArrow(l_arrow), GrowArrow(r_arrow), run_time=0.7)

        l_sent = chip("SENT — auto", RED, w=2.9).next_to(l_arrow, DOWN, buff=0.08)
        r_pending = chip("Draft — PENDING", GOLD, w=3.3).next_to(r_arrow, DOWN, buff=0.08)
        self.play(FadeIn(l_sent), FadeIn(r_pending), run_time=0.6)
        self.wait(0.6)

        l_note = Text("no human in the loop", color=RED).scale(0.32).next_to(l_sent, DOWN, buff=0.35)
        r_gate = card("a human approves", "the ONE send path", AGENT, w=3.6, h=1.0, tscale=0.34, sscale=0.26)
        r_gate.next_to(r_pending, DOWN, buff=0.35)
        self.play(FadeIn(l_note), run_time=0.5)
        self.play(FadeIn(r_gate, shift=UP * 0.15), run_time=0.6)
        self.wait(1.6)

        proof = Text("source-scan test: zero dispatch/approve calls in runner.ts",
                     color=AGENT, weight=BOLD).scale(0.34).to_edge(DOWN, buff=0.4)
        self.play(Write(proof), run_time=1.4)
        self.wait(3.5)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.7)

        # ---------- 4. WAITING DURABLY (~8s) ----------
        e_h = Text("Waiting durably", weight=BOLD, color=DEC).scale(0.64).to_edge(UP, buff=0.7)
        self.play(Write(e_h), run_time=1.1)

        seam = card("Executor", "the durable-wait seam", DEC, w=4.0, h=1.15, tscale=0.42, sscale=0.28)
        seam.shift(UP * 1.3)
        self.play(FadeIn(seam, shift=DOWN * 0.2), run_time=0.7)

        direct = card("DirectExecutor", "offline default • in-process", GREY_C, w=4.6, h=1.05, tscale=0.34, sscale=0.24)
        hatchet = card("HatchetExecutor", "opt-in • crash-resume", DEC, w=4.2, h=1.05, tscale=0.34, sscale=0.24)
        direct.move_to(LEFT * 3.3 + DOWN * 0.7)
        hatchet.move_to(RIGHT * 3.3 + DOWN * 0.7)
        a1 = Arrow(seam.get_bottom(), direct.get_top(), buff=0.15, color=GREY_B, stroke_width=2.5)
        a2 = Arrow(seam.get_bottom(), hatchet.get_top(), buff=0.15, color=GREY_B, stroke_width=2.5)
        self.play(GrowArrow(a1), GrowArrow(a2), run_time=0.6)
        self.play(FadeIn(direct), FadeIn(hatchet), run_time=0.6)
        self.wait(1.0)

        tick_cmd = Text("mstack sequence tick  ->  advances whatever is due",
                        color=GREEN).scale(0.34).to_edge(DOWN, buff=0.6)
        self.play(Write(tick_cmd), run_time=1.2)
        self.wait(2.2)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.6)

        # ---------- 5. THE RETURN LEG (~7.5s) ----------
        r_h = Text("The return leg", weight=BOLD, color=MEM).scale(0.64).to_edge(UP, buff=0.7)
        self.play(Write(r_h), run_time=1.1)

        ingest = Text("mstack ingest-outcomes", color=GREEN).scale(0.36).next_to(r_h, DOWN, buff=0.45)
        self.play(FadeIn(ingest), run_time=0.6)

        outcome = card("Outcome", "replied  •  meeting", MEM, w=3.4, h=1.15, tscale=0.4, sscale=0.28)
        outcome.move_to(UP * 0.5)
        self.play(FadeIn(outcome, shift=UP * 0.2), run_time=0.6)
        self.wait(0.4)

        stop_box = card("sequence", "STOPPED — no more follow-ups", STOP, w=4.0, h=1.1, tscale=0.36, sscale=0.24)
        qual_box = card("qualifier", "labels for train-qualifier", AGENT, w=3.6, h=1.1, tscale=0.36, sscale=0.24)
        stop_box.move_to(LEFT * 3.2 + DOWN * 1.5)
        qual_box.move_to(RIGHT * 3.2 + DOWN * 1.5)
        a1 = Arrow(outcome.get_bottom(), stop_box.get_top(), buff=0.15, color=STOP, stroke_width=3)
        a2 = Arrow(outcome.get_bottom(), qual_box.get_top(), buff=0.15, color=AGENT, stroke_width=3)
        self.play(GrowArrow(a1), GrowArrow(a2), run_time=0.7)
        self.play(FadeIn(stop_box), FadeIn(qual_box), run_time=0.6)
        self.wait(2.9)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.6)

        # ---------- 6. THE FUNNEL (~18.5s) ----------
        f_h = Text("mstack report — the funnel", weight=BOLD, color=MEM).scale(0.6).to_edge(UP, buff=0.6)
        self.play(Write(f_h), run_time=1.2)
        sample_note = Text("(sample data — illustrative shape, not a live run)", color=GREY_C).scale(0.24)
        sample_note.next_to(f_h, DOWN, buff=0.25)
        self.play(FadeIn(sample_note), run_time=0.5)

        stage_labels = ["Signals", "Scored", "Decisions", "Drafts", "Approved", "Sent", "Replied", "Meeting"]
        counts = [500, 340, 240, 210, 180, 150, 60, 22]
        max_c = max(counts)
        max_h = 2.2
        bar_w = 1.2
        gap = 0.3
        n = len(counts)
        total_w = n * bar_w + (n - 1) * gap
        start_x = -total_w / 2 + bar_w / 2
        baseline_y = -0.9

        bars = VGroup()
        count_lbls = VGroup()
        name_lbls = VGroup()
        for i, (name, c) in enumerate(zip(stage_labels, counts)):
            bh = max(0.2, (c / max_c) * max_h)
            rect = Rectangle(width=bar_w, height=bh, color=MEM, fill_color=MEM,
                             fill_opacity=0.55, stroke_width=2)
            x = start_x + i * (bar_w + gap)
            rect.move_to([x, baseline_y + bh / 2, 0])
            bars.add(rect)
            clbl = Text(str(c), color=WHITE).scale(0.24).next_to(rect, UP, buff=0.08)
            count_lbls.add(clbl)
            nlbl = Text(name, color=GREY_B).scale(0.2).next_to(rect, DOWN, buff=0.12)
            name_lbls.add(nlbl)

        self.play(LaggedStart(*[Create(b) for b in bars], lag_ratio=0.15), run_time=1.8)
        self.play(LaggedStart(*[FadeIn(l) for l in count_lbls], lag_ratio=0.08),
                  LaggedStart(*[FadeIn(l) for l in name_lbls], lag_ratio=0.08), run_time=0.8)

        pct_row_y = baseline_y + max_h + 0.6
        percents = VGroup()
        for i in range(1, n):
            pct = counts[i] / counts[i - 1]
            mid_x = (bars[i - 1].get_center()[0] + bars[i].get_center()[0]) / 2
            ptxt = Text(f"{pct * 100:.0f}%", color=GOLD).scale(0.22).move_to([mid_x, pct_row_y, 0])
            percents.add(ptxt)
        self.play(LaggedStart(*[FadeIn(p) for p in percents], lag_ratio=0.08), run_time=0.9)
        self.wait(2.5)

        self.play(*[FadeOut(m) for m in [bars, count_lbls, name_lbls, percents]], run_time=0.6)

        tier_h = Text("conversion by tier — meeting rate", color=ACT, weight=BOLD).scale(0.4)
        tier_h.next_to(f_h, DOWN, buff=0.7)
        self.play(Write(tier_h), run_time=0.9)

        tiers = ["STRONG_FIT", "FIT", "PARTIAL_FIT", "DISQUALIFIED"]
        tier_rates = [18, 9, 3, 0]
        tier_colors = [AGENT, TEAL, GOLD, GREY_C]
        tbar_w = 2.1
        tgap = 0.45
        ttotal = 4 * tbar_w + 3 * tgap
        tstart = -ttotal / 2 + tbar_w / 2
        tmax_h = 2.0
        tbaseline = -0.9

        tbars = VGroup()
        tvals = VGroup()
        tlbls = VGroup()
        for i, (name, rr, col) in enumerate(zip(tiers, tier_rates, tier_colors)):
            bh = max(0.18, (rr / 18) * tmax_h)
            rect = Rectangle(width=tbar_w, height=bh, color=col, fill_color=col,
                             fill_opacity=0.55, stroke_width=2)
            x = tstart + i * (tbar_w + tgap)
            rect.move_to([x, tbaseline + bh / 2, 0])
            tbars.add(rect)
            tvals.add(Text(f"{rr}%", color=WHITE).scale(0.3).next_to(rect, UP, buff=0.1))
            tlbls.add(Text(name, color=GREY_B).scale(0.24).next_to(rect, DOWN, buff=0.15))
        self.play(LaggedStart(*[Create(b) for b in tbars], lag_ratio=0.15), run_time=1.2)
        self.play(*[FadeIn(v) for v in tvals], *[FadeIn(l) for l in tlbls], run_time=0.6)
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in [tier_h, tbars, tvals, tlbls]], run_time=0.6)

        rev1 = Text("Review outcomes — 82% approval rate", color=SIG, weight=BOLD).scale(0.4)
        rev2 = Text("top claim-drift: guaranteed_outcome, unapproved_superlative",
                    color=GREY_A).scale(0.32)
        rev = VGroup(rev1, rev2).arrange(DOWN, buff=0.3)
        rev.next_to(f_h, DOWN, buff=0.9)
        self.play(FadeIn(rev, shift=UP * 0.2), run_time=0.8)
        self.wait(3.6)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.7)

        # ---------- 7. DELIVERY — CrmSync (~8.5s) ----------
        c_h = Text("Delivery — CrmSync", weight=BOLD, color=CRM).scale(0.62).to_edge(UP, buff=0.7)
        self.play(Write(c_h), run_time=1.1)

        crm = card("CrmSync", "score  •  decision  •  outcome", CRM, w=4.6, h=1.15, tscale=0.4, sscale=0.26)
        crm.shift(UP * 1.1)
        self.play(FadeIn(crm, shift=DOWN * 0.2), run_time=0.7)

        sf = card("Salesforce", "", GREY_C, w=3.0, h=0.85, tscale=0.34).move_to(LEFT * 3.0 + DOWN * 0.9)
        hs = card("HubSpot", "", GREY_C, w=3.0, h=0.85, tscale=0.34).move_to(RIGHT * 3.0 + DOWN * 0.9)
        a1 = Arrow(crm.get_bottom(), sf.get_top(), buff=0.15, color=CRM, stroke_width=3)
        a2 = Arrow(crm.get_bottom(), hs.get_top(), buff=0.15, color=CRM, stroke_width=3)
        self.play(GrowArrow(a1), GrowArrow(a2), run_time=0.7)
        self.play(FadeIn(sf), FadeIn(hs), run_time=0.6)
        self.wait(0.5)

        allow_note = Text("allowlist: record-update actions only — never a second send path",
                          color=GREY_A).scale(0.3)
        allow_note.to_edge(DOWN, buff=1.1)
        allow_ok = Text("UPDATE_CONTACT — allowed", color=AGENT).scale(0.32)
        allow_bad = Text("SEND_EMAIL — refused", color=RED).scale(0.32)
        allow = VGroup(allow_ok, allow_bad).arrange(RIGHT, buff=0.8).next_to(allow_note, DOWN, buff=0.3)
        self.play(FadeIn(allow_note), run_time=0.7)
        self.play(FadeIn(allow_ok, shift=RIGHT * 0.15), FadeIn(allow_bad, shift=RIGHT * 0.15), run_time=0.7)
        self.wait(2.8)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.7)

        # ---------- 8. CLOSE (~6.5s) ----------
        close1 = Text("Cadence, measurement, and CRM delivery", weight=BOLD).scale(0.58)
        close2 = Text("— with a human on every send", color=AGENT, weight=BOLD).scale(0.52)
        close2.next_to(close1, DOWN, buff=0.35)
        close3 = Text("Marketing Agents Stack  •  offline, deterministic, open", color=GREY_A).scale(0.38)
        close3.next_to(close2, DOWN, buff=0.6)
        self.play(Write(close1), run_time=1.3)
        self.play(FadeIn(close2, shift=UP * 0.2), run_time=0.8)
        self.play(FadeIn(close3, shift=UP * 0.2), run_time=0.7)
        self.wait(3.1)
        self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.6)
