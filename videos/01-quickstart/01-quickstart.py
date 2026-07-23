"""Zero to a closed loop in five commands -- offline, no API key.

Plain Manim CE (no LaTeX; every label is Text/Paragraph). Dark palette to match
the SignalSphere console + the marketing-agents-loop explainer. Render:
  python .../scripts/render.py --scene 01-quickstart.py --quality l
"""
from manim import *

BG = "#0d1117"
SIG = BLUE
DEC = TEAL
ACT = GOLD
MEM = PURPLE
AGENT = "#7ee787"   # soft green accent -- success / "it worked"
WARN = "#ff7b72"    # soft red accent -- "needs a human look"


def cap_width(m, max_w):
    """Clamp a mobject's width so it can never overflow the frame."""
    if m.width > max_w:
        m.set(width=max_w)
    return m


def place_left(m, x, y):
    """Position m so its LEFT edge sits at x, vertically centered at y."""
    m.move_to(RIGHT * (x + m.width / 2) + UP * y)
    return m


def card(label, sub, color, w=2.9, h=1.45, tscale=0.5, sscale=0.3):
    box = RoundedRectangle(width=w, height=h, corner_radius=0.18,
                           color=color, fill_color=color, fill_opacity=0.16, stroke_width=3)
    t = cap_width(Text(label, color=WHITE, weight=BOLD).scale(tscale), w - 0.5)
    parts = [t]
    if sub:
        s = cap_width(Text(sub, color=GREY_B).scale(sscale), w - 0.5)
        parts.append(s)
    inner = VGroup(*parts).arrange(DOWN, buff=0.12).move_to(box.get_center())
    return VGroup(box, inner)


def terminal(lines, max_line_w=9.4):
    """A small dark console card. lines: list of (text, color) tuples."""
    rows = VGroup(*[cap_width(Text(t, color=c).scale(0.34), max_line_w) for t, c in lines])
    rows.arrange(DOWN, aligned_edge=LEFT, buff=0.22)
    pad_x, pad_top, pad_bot = 0.5, 0.7, 0.4
    box = RoundedRectangle(width=rows.width + 2 * pad_x, height=rows.height + pad_top + pad_bot,
                           corner_radius=0.15, color=GREY_C, fill_color="#161b22",
                           fill_opacity=1.0, stroke_width=2)
    dots = VGroup(*[Dot(radius=0.05, color=c) for c in ["#ff5f56", "#ffbd2e", "#27c93f"]])
    dots.arrange(RIGHT, buff=0.13)
    dots.move_to(box.get_corner(UL)).shift(RIGHT * 0.5 + DOWN * 0.28)
    rows.move_to(box.get_center()).shift(DOWN * (pad_top - pad_bot) / 2)
    rows.align_to(box, LEFT).shift(RIGHT * pad_x)
    return VGroup(box, dots, rows)


class Quickstart(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. HOOK ----------
        tag = Text("01  •  quickstart", color=GREY_C).scale(0.32).to_corner(UR, buff=0.35)
        title = Text("Marketing Agents Stack", weight=BOLD).scale(1.0)
        tagline = Text("zero -> a closed loop, in five commands", color=TEAL).scale(0.48)
        tagline.next_to(title, DOWN, buff=0.3)
        sub = Text("no API key  •  no network", color=GREY_A).scale(0.38)
        sub.next_to(tagline, DOWN, buff=0.32)
        self.play(FadeIn(tag), Write(title))
        self.play(FadeIn(tagline, shift=UP * 0.3))
        self.play(FadeIn(sub, shift=UP * 0.2))
        self.wait(1.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 2. INSTALL + SEED ----------
        h2 = cap_width(Text("Two commands: install, then seed", weight=BOLD).scale(0.62), 12.0)
        h2.to_edge(UP, buff=0.6)
        self.play(Write(h2))
        term1 = terminal([
            ("$ pnpm install && pnpm -r build", GREY_A),
            ("$ node dist/cli.js seed", WHITE),
        ]).shift(UP * 0.25)
        self.play(FadeIn(term1, shift=UP * 0.2))
        self.wait(0.7)
        seed_out = cap_width(
            Text("loaded offline fixtures: signals  •  guidelines  •  corpus", color=AGENT).scale(0.36),
            12.5,
        )
        seed_out.next_to(term1, DOWN, buff=0.45)
        self.play(FadeIn(seed_out, shift=UP * 0.15))
        self.wait(2.0)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 3. RUN THE DEMO ----------
        h3a = Text("mstack demo", weight=BOLD, color=AGENT).scale(0.85)
        h3b = Text("runs the whole loop -- offline", color=GREY_A).scale(0.42)
        h3b.next_to(h3a, DOWN, buff=0.3)
        self.play(Write(h3a))
        self.play(FadeIn(h3b, shift=UP * 0.2))
        self.wait(1.4)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 4. CONTENT-REVIEW ----------
        h4 = Text("CONTENT-REVIEW", weight=BOLD, color=SIG).scale(0.66).to_edge(UP, buff=0.55)
        sub4 = cap_width(Text("4 partner assets -> reviewed for claim drift", color=GREY_A).scale(0.36), 12.0)
        sub4.next_to(h4, DOWN, buff=0.16)
        self.play(Write(h4), FadeIn(sub4))
        self.wait(0.5)

        abc = card("ABC Corp", "RETURNED  •  1/5  •  7 findings", WARN,
                   w=5.6, h=1.5, tscale=0.48, sscale=0.34).shift(LEFT * 3.3 + UP * 0.1)
        nl = card("Northland Analytics", "APPROVED  •  5/5  •  0 findings", AGENT,
                  w=5.6, h=1.5, tscale=0.4, sscale=0.34).shift(RIGHT * 3.3 + UP * 0.1)
        self.play(FadeIn(abc, shift=UP * 0.2), FadeIn(nl, shift=UP * 0.2), run_time=1.2)
        self.wait(0.7)

        cats = cap_width(
            Text(
                "findings are categorized: guaranteed_outcome  •  uncited_quantitative  •  badge_tier_misuse  •  ...",
                color=GREY_B,
            ).scale(0.3),
            12.6,
        )
        cats.next_to(VGroup(abc, nl), DOWN, buff=0.55)
        self.play(FadeIn(cats))
        self.wait(0.6)
        more4 = Text("+ 2 more reviewed: Victorly, BrightPath", color=GREY_C).scale(0.32)
        more4.next_to(cats, DOWN, buff=0.28)
        self.play(FadeIn(more4))
        self.wait(2.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 5. ACCOUNT-ACTIVATION ----------
        h5 = Text("ACCOUNT-ACTIVATION", weight=BOLD, color=ACT).scale(0.66).to_edge(UP, buff=0.55)
        sub5 = cap_width(Text("signals -> score -> decision -> drafted email", color=GREY_A).scale(0.36), 12.0)
        sub5.next_to(h5, DOWN, buff=0.16)
        self.play(Write(h5), FadeIn(sub5))
        self.wait(0.5)

        figma = card("figma.com", "75/100  •  STRONG_FIT", AGENT,
                     w=5.2, h=1.5, tscale=0.46, sscale=0.36).shift(LEFT * 3.3 + UP * 0.1)
        airtb = card("airtable.com", "55/100  •  FIT", DEC,
                     w=5.2, h=1.5, tscale=0.46, sscale=0.36).shift(RIGHT * 3.3 + UP * 0.1)
        self.play(FadeIn(figma, shift=UP * 0.2), FadeIn(airtb, shift=UP * 0.2), run_time=1.2)
        self.wait(0.8)

        action5 = cap_width(
            Text(
                "each carries a next-best action + a targeted buying-committee member",
                color=GREY_B,
            ).scale(0.33),
            12.6,
        )
        action5.next_to(VGroup(figma, airtb), DOWN, buff=0.6)
        self.play(FadeIn(action5))
        self.wait(3.0)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 6. THE PUNCHLINE (hero) ----------
        h6a = cap_width(Text("DRAFTS AWAITING APPROVAL", weight=BOLD, color=ACT).scale(0.72), 12.0)
        count6 = Text("(10 pending)", color=GREY_A).scale(0.5)
        count6.next_to(h6a, DOWN, buff=0.3)
        self.play(Write(h6a))
        self.play(FadeIn(count6, shift=UP * 0.2))
        self.wait(1.3)
        self.play(FadeOut(h6a), FadeOut(count6))

        outbox_line = Text("OUTBOX: EMPTY", weight=BOLD, color=ACT).scale(1.0)
        outbox_sub = Text("(0 dispatched)", color=GREY_A).scale(0.5)
        outbox_sub.next_to(outbox_line, DOWN, buff=0.25)
        self.play(Write(outbox_line), run_time=1.3)
        self.play(FadeIn(outbox_sub, shift=UP * 0.15))
        self.wait(0.9)
        outbox_thesis = Text("nothing was sent.", color=AGENT, weight=BOLD).scale(0.6)
        outbox_thesis.next_to(outbox_sub, DOWN, buff=0.5)
        self.play(FadeIn(outbox_thesis, shift=UP * 0.2))
        self.wait(3.0)  # HOLD -- this is the thesis
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 7. mstack approve <draftId> ----------
        h7 = cap_width(Text("mstack approve <draftId>", weight=BOLD, color=ACT).scale(0.58), 12.0)
        h7.to_edge(UP, buff=0.7)
        self.play(Write(h7))

        before = card("a pending draft", "status: pending", GREY_C, w=4.4, h=1.5, tscale=0.4, sscale=0.34)
        before.shift(LEFT * 3.1)
        self.play(FadeIn(before, shift=UP * 0.2))
        self.wait(0.6)

        arrow7 = Arrow(before.get_right(), before.get_right() + RIGHT * 2.2, buff=0.15,
                       color=WHITE, stroke_width=3)
        self.play(GrowArrow(arrow7))
        after = card("a pending draft", "status: sent", AGENT, w=4.4, h=1.5, tscale=0.4, sscale=0.34)
        after.next_to(arrow7, RIGHT, buff=0.15)
        self.play(FadeIn(after, shift=RIGHT * 0.2))
        self.wait(0.5)

        outbox_note = cap_width(
            Text("-> lands in outbox/, hash-chain verified", color=GREY_A).scale(0.38), 11.0,
        )
        outbox_note.to_edge(DOWN, buff=0.95)
        self.play(FadeIn(outbox_note))
        self.wait(0.6)
        thesis7 = cap_width(
            Text("the loop closes because a human closed it", weight=BOLD, color=AGENT).scale(0.5), 12.0,
        )
        thesis7.to_edge(DOWN, buff=0.4)
        self.play(Write(thesis7))
        self.wait(2.0)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 8. CLOSE ----------
        h8 = Text("mstack report", weight=BOLD, color=MEM).scale(0.72)
        sub8 = cap_width(
            Text("the GTM funnel  •  conversion by tier  •  review outcomes", color=GREY_A).scale(0.38),
            12.5,
        )
        sub8.next_to(h8, DOWN, buff=0.3)
        self.play(Write(h8))
        self.play(FadeIn(sub8, shift=UP * 0.15))
        self.wait(1.2)
        self.play(FadeOut(h8), FadeOut(sub8))

        surfaces_h = cap_width(
            Text("two web surfaces, both auto-seeded, both offline", weight=BOLD).scale(0.56), 12.0,
        )
        surfaces_h.to_edge(UP, buff=0.8)
        self.play(Write(surfaces_h))
        console_card = card("Console", ":4320  •  ops + funnel", SIG, w=4.8, h=1.5, tscale=0.46, sscale=0.34)
        console_card.shift(LEFT * 2.7)
        portal_card = card("Portal", ":4321  •  approval bench", ACT, w=4.8, h=1.5, tscale=0.46, sscale=0.34)
        portal_card.shift(RIGHT * 2.7)
        self.play(FadeIn(console_card, shift=RIGHT * 0.3), FadeIn(portal_card, shift=LEFT * 0.3))
        self.wait(1.5)
        self.play(FadeOut(surfaces_h), FadeOut(console_card), FadeOut(portal_card))

        final1 = Text("Open  •  Offline-first  •  Claude-native", weight=BOLD).scale(0.66)
        final2 = cap_width(
            Text("everything above ran offline, deterministic, keyless", color=TEAL).scale(0.42), 12.5,
        )
        final2.next_to(final1, DOWN, buff=0.35)
        self.play(Write(final1))
        self.play(FadeIn(final2, shift=UP * 0.2))
        self.wait(2.8)
        self.play(*[FadeOut(m) for m in self.mobjects])
