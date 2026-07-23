"""Offline by default, SOTA when you want it -- the seam pattern behind every
external dependency in the Marketing Agents Stack.

Plain Manim CE (no LaTeX; every label is Text/Paragraph). Dark palette to match
marketing-agents-loop.py. Render:
  python .../scripts/render.py --scene 03-seams.py --quality l
"""
from manim import *

BG = "#0d1117"
SIG = BLUE
ENR = TEAL
SCORE = GOLD
OUT = ORANGE
EXEC = PURPLE
MEM = PINK
AGENT = "#7ee787"       # soft green accent -- "it works" / emphasis beats
BAD = "#ff6b6b"          # soft red -- the degrade beat
CONSOLE_BG = "#161b22"   # slightly-lighter-than-BG strip for the log line


def card(label, sub, color, w=3.2, h=1.4, tscale=0.42, sscale=0.3):
    box = RoundedRectangle(width=w, height=h, corner_radius=0.16,
                           color=color, fill_color=color, fill_opacity=0.16, stroke_width=3)
    t = Text(label, color=WHITE, weight=BOLD).scale(tscale)
    parts = [t]
    if sub:
        s = Text(sub, color=GREY_A).scale(sscale)
        parts.append(s)
    inner = VGroup(*parts).arrange(DOWN, buff=0.12).move_to(box.get_center())
    return VGroup(box, inner)


def seam_row(name, color, default_txt, upgrade_txt):
    """One line of the seams grid: [chip+name]  default -> upgrade."""
    chip = Square(side_length=0.22, color=color, fill_color=color, fill_opacity=0.9, stroke_width=0)
    name_t = Text(name, color=WHITE, weight=BOLD).scale(0.34)
    left = VGroup(chip, name_t).arrange(RIGHT, buff=0.18)
    dflt = Text(default_txt, color=GREY_A).scale(0.3)
    arrow = Arrow(LEFT * 0.35, RIGHT * 0.35, buff=0, color=GREY_B, stroke_width=2.5,
                  max_tip_length_to_length_ratio=0.4)
    upg = Text(upgrade_txt, color=color).scale(0.3)
    return VGroup(left, dflt, arrow, upg).arrange(RIGHT, buff=0.3)


class Seams(Scene):
    def construct(self):
        self.camera.background_color = BG

        # ---------- 1. HOOK ----------
        claim = Text("The loop runs keyless. Offline. No API keys.", weight=BOLD).scale(0.62)
        self.play(Write(claim))
        self.wait(0.9)
        q = Text("So how does it also reach for best-in-class tools?", color=GOLD).scale(0.5)
        q.next_to(claim, DOWN, buff=0.45)
        self.play(FadeIn(q, shift=UP * 0.2))
        self.wait(1.1)
        self.play(FadeOut(claim), FadeOut(q))

        answer1 = Text("Every external dependency sits behind a", color=GREY_A).scale(0.5)
        answer2 = Text("SEAM", weight=BOLD, color=AGENT).scale(0.9)
        answer3 = Text("with an offline default.", color=GREY_A).scale(0.5)
        answer1.shift(UP * 0.9)
        answer2.next_to(answer1, DOWN, buff=0.35)
        answer3.next_to(answer2, DOWN, buff=0.35)
        self.play(FadeIn(answer1, shift=UP * 0.15))
        self.play(Write(answer2))
        self.play(FadeIn(answer3, shift=UP * 0.15))
        self.wait(1.4)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 2. THE SEAMS (grid) ----------
        g_h = Text("6 seams. Each ships an offline default.", weight=BOLD).scale(0.62).to_edge(UP, buff=0.6)
        self.play(Write(g_h))

        rows_data = [
            ("SignalSource", SIG, "sample JSONL", "PostHog / GitHub / Segment"),
            ("EnrichmentProvider", ENR, "fetch + strip tags", "Crawl4AI / Firecrawl"),
            ("ScoringProvider", SCORE, "deterministic rules", "+Claude cold-start / +ONNX"),
            ("OutreachChannel", OUT, "local outbox file", "Composio (1000+ apps)"),
            ("Executor", EXEC, "in-process", "Hatchet (durable, crash-resume)"),
            ("Recall / Approver", MEM, "none / portal UI", "Graphiti / HumanLayer"),
        ]
        rows = VGroup(*[seam_row(*r) for r in rows_data]).arrange(DOWN, buff=0.32, aligned_edge=LEFT)
        rows.move_to(ORIGIN + DOWN * 0.15)
        self.play(LaggedStart(*[FadeIn(r, shift=RIGHT * 0.25) for r in rows], lag_ratio=0.18, run_time=2.2))
        self.wait(2.6)
        self.play(FadeOut(g_h), *[FadeOut(r) for r in rows])

        # ---------- 3. ZOOM INTO ONE ----------
        z_h = Text("Zoom into one: FetchSite", weight=BOLD, color=ENR).scale(0.62).to_edge(UP, buff=0.6)
        sig = Text("FetchSite  =  (url)  ->  Promise<string>", color=GREY_A).scale(0.38)
        sig.next_to(z_h, DOWN, buff=0.4)
        self.play(Write(z_h))
        self.play(FadeIn(sig, shift=UP * 0.15))
        self.wait(0.8)

        default_card = card("defaultFetchSite", "fetch + strip tags", GREY_C, w=3.6, h=1.5).shift(LEFT * 3.2 + DOWN * 0.6)
        crawl_card = card("crawl4aiFetchSite", "JS-rendered, cleaned markdown", ENR, w=4.4, h=1.5).shift(RIGHT * 3.1 + DOWN * 0.6)
        swap_arrow = Arrow(default_card.get_right(), crawl_card.get_left(), buff=0.2, color=AGENT, stroke_width=4)
        swap_lbl = Text("register it", color=AGENT).scale(0.34).next_to(swap_arrow, UP, buff=0.08)
        self.play(FadeIn(default_card, shift=RIGHT * 0.3))
        self.wait(0.5)
        self.play(GrowArrow(swap_arrow), FadeIn(swap_lbl))
        self.play(FadeIn(crawl_card, shift=LEFT * 0.3))
        self.wait(0.6)

        note = Text("same seam, same callers -- nothing downstream changes", color=GREY_A).scale(0.4)
        note.to_edge(DOWN, buff=0.7)
        self.play(Write(note))
        self.wait(1.8)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 4. DEGRADE, DON'T BREAK ----------
        d_h = Text("The sidecar goes down.", weight=BOLD, color=BAD).scale(0.62).to_edge(UP, buff=0.7)
        self.play(Write(d_h))

        crawl2 = card("crawl4aiFetchSite", "sidecar unreachable", ENR, w=4.0, h=1.4).shift(UP * 0.9)
        default2 = card("defaultFetchSite", "always available", GREY_C, w=3.6, h=1.3).shift(DOWN * 1.6)
        x1 = Line(crawl2.get_corner(UL) + RIGHT * 0.3 + DOWN * 0.15, crawl2.get_corner(DR) + LEFT * 0.3 + UP * 0.15,
                  color=BAD, stroke_width=5)
        x2 = Line(crawl2.get_corner(UR) + LEFT * 0.3 + DOWN * 0.15, crawl2.get_corner(DL) + RIGHT * 0.3 + UP * 0.15,
                  color=BAD, stroke_width=5)
        self.play(FadeIn(crawl2))
        self.wait(0.5)
        self.play(Create(x1), Create(x2), run_time=0.5)

        fallback_arrow = CurvedArrow(crawl2.get_bottom(), default2.get_top(), color=BAD, angle=-PI * 0.35)
        self.play(FadeIn(default2, shift=DOWN * 0.2))
        self.play(Create(fallback_arrow), run_time=0.7)

        log_strip = Rectangle(width=10.8, height=0.7, color=GREY_D, fill_color=CONSOLE_BG,
                              fill_opacity=1.0, stroke_width=1)
        log_strip.to_edge(DOWN, buff=0.35)
        log_txt = Text("falling back to defaultFetchSite -- degraded, not broken", color=AGENT).scale(0.32)
        log_txt.move_to(log_strip.get_center())
        self.play(FadeIn(log_strip), Write(log_txt))
        self.wait(1.5)
        keep_running = Text("the loop keeps running", weight=BOLD, color=AGENT).scale(0.5)
        keep_running.next_to(crawl2, RIGHT, buff=0.6)
        self.play(FadeIn(keep_running, shift=LEFT * 0.2))
        self.wait(1.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 5. THE RULE ----------
        r_h = Text("The rule", weight=BOLD).scale(0.7).to_edge(UP, buff=0.6)
        self.play(Write(r_h))

        py_head = Text("Python tools -> HTTP sidecars", weight=BOLD, color=OUT).scale(0.4)
        py_list = Paragraph("Crawl4AI", "GPT-Researcher", "Graphiti", "Presidio",
                            alignment="left", color=GREY_A).scale(0.34)
        py_note = Text("never vendored into the strict-ESM TS tree", color=GREY_B).scale(0.28)
        py_col = VGroup(py_head, py_list, py_note).arrange(DOWN, buff=0.3, aligned_edge=LEFT)
        py_col.move_to(LEFT * 3.4 + DOWN * 0.2)

        ts_head = Text("TS SDKs -> lazy dynamic import", weight=BOLD, color=SIG).scale(0.4)
        ts_list = Paragraph("Composio", "Hatchet", "HumanLayer",
                            alignment="left", color=GREY_A).scale(0.34)
        ts_note = Text("never touch the offline module graph", color=GREY_B).scale(0.28)
        ts_col = VGroup(ts_head, ts_list, ts_note).arrange(DOWN, buff=0.3, aligned_edge=LEFT)
        ts_col.move_to(RIGHT * 3.2 + DOWN * 0.2)

        divider = Line(UP * 1.9, DOWN * 2.1, color=GREY_D, stroke_width=1.5).move_to(ORIGIN + DOWN * 0.2)

        self.play(FadeIn(py_col, shift=RIGHT * 0.3), FadeIn(ts_col, shift=LEFT * 0.3), Create(divider))
        self.wait(2.4)
        extra_note = Text("Python is called over HTTP -- it is never imported into the runtime.",
                          color=GREY_A).scale(0.34).to_edge(DOWN, buff=0.5)
        self.play(FadeIn(extra_note))
        self.wait(1.6)
        self.play(*[FadeOut(m) for m in self.mobjects])

        # ---------- 6. CLOSE ----------
        guard = card("OutreachChannel.dispatch(...)",
                    "still needs a valid Approval -- a type on the seam, not a variable",
                    SIG, w=9.6, h=1.5, tscale=0.4, sscale=0.3)
        guard.shift(UP * 1.3)
        self.play(FadeIn(guard, shift=UP * 0.2))
        self.wait(1.0)
        unaff = Text("no seam swap ever touches the guardrails", color=GREY_A).scale(0.4)
        unaff.next_to(guard, DOWN, buff=0.4)
        self.play(FadeIn(unaff))
        self.wait(1.0)

        tag1 = Text("Adopt the best tool.", weight=BOLD).scale(0.7)
        tag2 = Text("Stay coupled to none.", weight=BOLD, color=AGENT).scale(0.7)
        tag1.next_to(unaff, DOWN, buff=0.7)
        tag2.next_to(tag1, DOWN, buff=0.25)
        self.play(Write(tag1))
        self.play(Write(tag2))
        self.wait(2.2)
        self.play(*[FadeOut(m) for m in self.mobjects])
