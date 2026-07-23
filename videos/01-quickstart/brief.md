# 01-quickstart — storyboard

**Takeaway (one sentence):** Five commands take a fresh clone to a closed
signal -> decision -> action loop — fully offline, no API key — and the loop
only ever closes because a human approved a send.

**Pattern:** terminal-driven walkthrough (the CLI output is the hero). Dark
palette to match the console/portal + `marketing-agents-loop`. ~80s, on-screen
captions, no narration.

## Beats
1. **Hook** (~6s) — "Marketing Agents Stack" title; tagline "zero -> a closed
   loop, in five commands"; sub-caption "no API key  •  no network"; small
   "01 • quickstart" corner tag for series continuity.
2. **Install + seed** (~8s) — a dark terminal card (traffic-light dots) types
   `$ pnpm install && pnpm -r build` then `$ node dist/cli.js seed`; a green
   result line fades in below: "loaded offline fixtures: signals • guidelines
   • corpus".
3. **Run the demo** (~4s) — short transition slide: "mstack demo" (green,
   the "go" moment) / "runs the whole loop -- offline".
4. **CONTENT-REVIEW** (~10s) — heading + "4 partner assets -> reviewed for
   claim drift". Two verdict cards side by side: **ABC Corp** (RETURNED •
   1/5 • 7 findings, warm/red card) and **Northland Analytics** (APPROVED •
   5/5 • 0 findings, green card). A caption names three finding categories
   (guaranteed_outcome, uncited_quantitative, badge_tier_misuse); a dimmed
   line notes the other two assets reviewed (Victorly, BrightPath) without
   inventing verdicts for them.
5. **ACCOUNT-ACTIVATION** (~9s) — heading + "signals -> score -> decision ->
   drafted email". Two decision cards: **figma.com** (75/100 • STRONG_FIT,
   green) and **airtable.com** (55/100 • FIT, teal). Caption: each carries a
   next-best action + a targeted buying-committee member.
6. **The punchline** (~14s, hero) — "DRAFTS AWAITING APPROVAL (10 pending)"
   in gold, holds, fades; then "OUTBOX: EMPTY (0 dispatched)" (gold) holds,
   and "nothing was sent." fades in beneath in bold green and HOLDS ~3s.
   This is the thesis — the whole beat is built to let it land.
7. **`mstack approve <draftId>`** (~13s) — a draft card reading "status:
   pending" (grey) crosses an arrow and becomes "status: sent" (green);
   caption "-> lands in outbox/, hash-chain verified"; closing line "the
   loop closes because a human closed it" (bold green).
8. **Close** (~17s) — `mstack report` (purple, the funnel / conversion by
   tier / review outcomes); two web-surface cards, Console (:4320 • ops +
   funnel, blue) and Portal (:4321 • approval bench, gold); final sign-off
   "Open • Offline-first • Claude-native" (matches the original explainer's
   closing line) + "everything above ran offline, deterministic, keyless".

Total estimated runtime: ~80s (sum of per-beat estimates above; not
render-measured — this scene was written but not rendered, per the
orchestrator's render-once-sequentially plan).
