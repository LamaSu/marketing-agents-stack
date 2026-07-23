"""Why nothing sends without you -- the approval gate, end to end.

Plain Manim CE (no LaTeX; every label is Text/Paragraph). Dark palette to match
the SignalSphere console / the marketing-agents-loop video. Render:
  python .../scripts/render.py --scene videos/02-the-gate/02-the-gate.py --quality l
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


class TheGate(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. HOOK ----------
        title = Text("The Gate", weight=BOLD).scale(1.1)
        tagline = Text("why nothing sends without you", color=GOLD).scale(0.5)
        tagline.next_to(title, DOWN, buff=0.3)
        self.play(Write(title))
        self.play(FadeIn(tagline, shift=UP * 0.3))
        self.wait(1.1)
        self.play(FadeOut(title), FadeOut(tagline))

        hook_h = Text("Agents draft. They do not send.", weight=BOLD, color=SIG).scale(0.6)
        hook_h.to_edge(UP, buff=0.7)
        self.play(Write(hook_h))

        agent_node = card("Agent", "reviewer / swarm / cadence", AGENT, w=3.2, h=1.3, tscale=0.42, sscale=0.28)
        draft_node = card("Draft", 'status: "pending"', SIG, w=2.8, h=1.3, tscale=0.46, sscale=0.3)
        send_node = card("send?", "", GREY_C, w=1.9, h=1.1, tscale=0.5)
        VGroup(agent_node, draft_node, send_node).arrange(RIGHT, buff=1.1).move_to(DOWN * 0.1)

        self.play(FadeIn(agent_node, shift=RIGHT * 0.3))
        a1 = Arrow(agent_node.get_right(), draft_node.get_left(), buff=0.18, color=WHITE, stroke_width=3)
        self.play(GrowArrow(a1), FadeIn(draft_node, shift=LEFT * 0.3))
        self.wait(0.5)

        a2 = Arrow(draft_node.get_right(), send_node.get_left(), buff=0.18, color=RED, stroke_width=3)
        self.play(GrowArrow(a2), FadeIn(send_node))
        block_sq1 = Square(side_length=0.7).move_to(a2.get_center())
        blocked = Cross(block_sq1, stroke_color=RED, stroke_width=6)
        self.play(Create(blocked), run_time=0.5)

        caption1 = Text("every outbound action becomes a Draft -- nothing leaves on its own",
                         color=GREY_A).scale(0.38)
        caption1.to_edge(DOWN, buff=0.75)
        self.play(Write(caption1))
        self.wait(1.5)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 2. ONE DOOR ----------
        door_h = Text("One door in", weight=BOLD, color=GOLD).scale(0.75)
        door_h.to_edge(UP, buff=0.7)
        self.play(Write(door_h))

        producers = VGroup(
            card("Reviewer", "", SIG, w=2.8, h=0.95, tscale=0.4),
            card("Account-Intel swarm", "", AGENT, w=2.8, h=0.95, tscale=0.32),
            card("Cadence engine", "", DEC, w=2.8, h=0.95, tscale=0.36),
        )
        producers.arrange(DOWN, buff=0.4).to_edge(LEFT, buff=0.9)

        gate = card("dispatchDraft()", "the only send path", GOLD, w=4.0, h=1.5, tscale=0.5, sscale=0.32)
        gate.move_to(RIGHT * 2.3)

        door_arrows = VGroup(*[
            Arrow(p.get_right(), gate.get_left(), buff=0.2, color=GREY_B, stroke_width=2,
                  max_tip_length_to_length_ratio=0.12)
            for p in producers
        ])

        self.play(LaggedStart(*[FadeIn(p) for p in producers], lag_ratio=0.2, run_time=0.9))
        self.play(Create(gate), *[GrowArrow(a) for a in door_arrows], run_time=1.0)
        self.play(Indicate(gate, color=GOLD, scale_factor=1.06), run_time=0.6)
        self.wait(0.4)

        test_note = Text('dispatch.test.ts greps the source for exactly one ".dispatch(" call site',
                          color=GREY_A).scale(0.36)
        test_note.to_edge(DOWN, buff=0.8)
        self.play(Write(test_note))
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 3. FOUR LOCKS (hero) ----------
        lock_h = Text("Four locks on that door", weight=BOLD, color=GOLD).scale(0.68)
        lock_h.to_edge(UP, buff=0.6)
        self.play(Write(lock_h))

        gate2 = card("dispatchDraft()", "checked before the channel is ever called", GOLD,
                     w=6.0, h=1.3, tscale=0.46, sscale=0.28)
        gate2.next_to(lock_h, DOWN, buff=0.45)
        self.play(FadeIn(gate2, shift=DOWN * 0.15))

        locks = [
            ("1. No Approval",
             "attempt: dispatch with no Approval at all",
             "refused -- no Approval supplied"),
            ("2. Wrong Draft",
             "attempt: Approval for a different draft, or not 'approve'",
             "refused -- wrong draft, or not an 'approve' decision"),
            ("3. Content Changed",
             "attempt: approve X, then edit the body before it sends",
             "refused -- contentHash no longer matches"),
            ("4. Forged Approval",
             "attempt: hand-craft an Approval that LOOKS valid",
             "refused -- no matching row in the hash-chained ledger"),
        ]

        chips = VGroup(*[card(name, "", GREY_C, w=2.7, h=0.85, tscale=0.3) for name, _, _ in locks])
        chips.arrange(RIGHT, buff=0.3).next_to(gate2, DOWN, buff=1.15)
        self.play(LaggedStart(*[FadeIn(c, shift=UP * 0.2) for c in chips], lag_ratio=0.2, run_time=1.0))
        self.wait(0.4)

        for i, (_, attempt_txt, refused_txt) in enumerate(locks):
            chip = chips[i]
            attempt = Text(attempt_txt, color=RED_A).scale(0.3)
            attempt.next_to(chip, DOWN, buff=0.3)
            self.play(FadeIn(attempt, shift=UP * 0.15), run_time=0.35)

            knock = Arrow(chip.get_top(), gate2.get_bottom(), buff=0.08, color=RED, stroke_width=3)
            self.play(GrowArrow(knock), run_time=0.35)
            self.play(Flash(gate2.get_center(), color=RED, flash_radius=0.7, line_length=0.35), run_time=0.4)

            refused = Text(refused_txt, color=RED, weight=BOLD).scale(0.32)
            refused.to_edge(DOWN, buff=0.55)
            block_sq3 = Square(side_length=0.55).move_to(chip.get_center())
            cross3 = Cross(block_sq3, stroke_color=RED, stroke_width=5)
            self.play(
                chip[0].animate.set_fill(RED, opacity=0.3).set_stroke(RED, width=3),
                Create(cross3), Write(refused), run_time=0.55,
            )
            self.wait(0.7)
            self.play(FadeOut(knock), FadeOut(attempt), FadeOut(refused), run_time=0.3)

        self.wait(0.3)
        locked_caption = Text("all four must hold -- every single time, before the channel is ever called",
                              color=GREY_A).scale(0.36)
        locked_caption.to_edge(DOWN, buff=0.6)
        self.play(Write(locked_caption))
        self.wait(1.4)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 4. WIN-ONCE ----------
        w_h = Text("Win-once: claimed, not raced", weight=BOLD, color=ACT).scale(0.62)
        w_h.to_edge(UP, buff=0.7)
        self.play(Write(w_h))

        s_approved = card("approved", "", ACT, w=2.6, h=1.0, tscale=0.4)
        s_dispatching = card("dispatching", "in flight", GOLD, w=2.8, h=1.0, tscale=0.38, sscale=0.26)
        s_dispatched = card("dispatched", "", TEAL, w=2.6, h=1.0, tscale=0.4)
        row = VGroup(s_approved, s_dispatching, s_dispatched).arrange(RIGHT, buff=1.0).move_to(UP * 1.3)
        self.play(FadeIn(row, shift=UP * 0.2))

        sm1 = Arrow(s_approved.get_right(), s_dispatching.get_left(), buff=0.15, color=WHITE, stroke_width=3)
        sm2 = Arrow(s_dispatching.get_right(), s_dispatched.get_left(), buff=0.15, color=WHITE, stroke_width=3)
        self.play(GrowArrow(sm1), GrowArrow(sm2), run_time=0.6)

        claim_note = Text("claimed by one atomic UPDATE ... WHERE status='approved'", color=GREY_A).scale(0.36)
        claim_note.next_to(row, DOWN, buff=0.45)
        self.play(FadeIn(claim_note))
        self.wait(0.7)

        callers = VGroup(Text("caller A", color=AGENT).scale(0.38), Text("caller B", color=RED_A).scale(0.38))
        callers.arrange(RIGHT, buff=2.2).next_to(claim_note, DOWN, buff=0.6)
        arrowA = Arrow(callers[0].get_top(), s_approved.get_bottom(), buff=0.15, color=AGENT, stroke_width=3)
        arrowB = Arrow(callers[1].get_top(), s_approved.get_bottom(), buff=0.15, color=RED_A, stroke_width=3)
        self.play(FadeIn(callers), GrowArrow(arrowA), GrowArrow(arrowB), run_time=0.7)
        self.wait(0.3)

        win_lbl = Text("wins the claim", color=AGENT).scale(0.3)
        win_lbl.next_to(callers[0], DOWN, buff=0.15)
        lose_lbl = Text("refused -- already claimed", color=RED).scale(0.3)
        lose_lbl.next_to(callers[1], DOWN, buff=0.15)
        block_sq4 = Square(side_length=0.7).move_to(arrowB.get_center())
        cross4 = Cross(block_sq4, stroke_color=RED, stroke_width=5)
        self.play(Write(win_lbl), Write(lose_lbl), Create(cross4), Indicate(sm1, color=AGENT), run_time=0.7)
        self.wait(0.8)
        self.play(FadeOut(callers), FadeOut(arrowA), FadeOut(arrowB), FadeOut(win_lbl), FadeOut(lose_lbl),
                  FadeOut(cross4), run_time=0.4)

        fail_arrow = CurvedArrow(s_dispatching.get_bottom() + DOWN * 0.1, s_approved.get_bottom() + DOWN * 0.1,
                                 color=RED, angle=-PI * 0.55)
        fail_label = Text("channel failure -> revert to 'approved' (stays retryable)", color=RED_A).scale(0.34)
        fail_label.next_to(fail_arrow, DOWN, buff=0.2)
        self.play(Create(fail_arrow), Write(fail_label), run_time=0.9)
        self.wait(1.2)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 5. THE LEDGER ----------
        ledger_h = Text("The ledger: hash-chained", weight=BOLD, color=MEM).scale(0.68)
        ledger_h.to_edge(UP, buff=0.65)
        self.play(Write(ledger_h))

        formula = Text("hash = sha256(prevHash + canonicalJson(record))", color=GREY_A).scale(0.38)
        formula.next_to(ledger_h, DOWN, buff=0.45)
        self.play(FadeIn(formula))
        self.wait(0.6)

        blocks = VGroup(*[card(f"Approval #{i + 1}", "", MEM, w=2.4, h=1.0, tscale=0.4) for i in range(4)])
        blocks.arrange(RIGHT, buff=0.6).move_to(DOWN * 0.5)
        chain_arrows = VGroup(*[
            Arrow(blocks[i].get_right(), blocks[i + 1].get_left(), buff=0.1, color=MEM, stroke_width=3)
            for i in range(3)
        ])

        self.play(LaggedStart(*[FadeIn(b, shift=UP * 0.2) for b in blocks], lag_ratio=0.25, run_time=1.1))
        self.play(*[GrowArrow(a) for a in chain_arrows], run_time=0.6)
        self.wait(0.6)

        tamper_note = Text("edit or reorder any retained row...", color=RED_A).scale(0.38)
        tamper_note.to_edge(DOWN, buff=1.35)
        self.play(Write(tamper_note))

        block_sq5 = Square(side_length=0.6).move_to(blocks[1].get_center())
        cross5 = Cross(block_sq5, stroke_color=RED, stroke_width=5)
        self.play(
            Flash(blocks[1].get_center(), color=RED, flash_radius=0.6, line_length=0.3),
            blocks[1][0].animate.set_fill(RED, opacity=0.3).set_stroke(RED, width=3),
            Create(cross5), run_time=0.6,
        )
        self.play(*[a.animate.set_color(RED) for a in chain_arrows[1:]], run_time=0.4)

        verify_fail = Text("verifyAuditChain()  ->  FAILS", color=RED, weight=BOLD).scale(0.42)
        verify_fail.to_edge(DOWN, buff=0.65)
        self.play(Write(verify_fail))
        self.wait(1.3)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 6. HONEST CLOSE ----------
        c1a = Text("Tamper-evident -- not cryptographically signed", color=GREY_A).scale(0.46)
        c1b = Text("proves consistency and order, not WHO approved it", color=GREY_B).scale(0.36)
        c1b.next_to(c1a, DOWN, buff=0.25)
        grp1 = VGroup(c1a, c1b).move_to(UP * 0.8)
        self.play(Write(c1a))
        self.play(FadeIn(c1b, shift=UP * 0.15))
        self.wait(1.3)
        self.play(FadeOut(grp1))

        c2a = Text("The only send path -- in the normal flow", color=GREY_A).scale(0.46)
        c2b = Text("in-process code holding a repo handle is trusted by design", color=GREY_B).scale(0.34)
        c2b.next_to(c2a, DOWN, buff=0.25)
        grp2 = VGroup(c2a, c2b).move_to(UP * 0.5)
        self.play(Write(c2a))
        self.play(FadeIn(c2b, shift=UP * 0.15))
        self.wait(1.4)
        self.play(FadeOut(grp2))

        final_line = Text("A human approves every send.", weight=BOLD, color=AGENT).scale(0.85)
        self.play(Write(final_line))
        self.wait(2.0)
        self.play(FadeOut(final_line))
