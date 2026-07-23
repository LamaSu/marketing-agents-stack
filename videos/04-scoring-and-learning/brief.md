# 04-scoring-and-learning — storyboard

**Takeaway (one sentence):** A score is only useful if it drives an action and gets
better — HybridScorer blends a deterministic rules floor with optional Claude/ONNX
scorers under a hard disqualified floor, then a Gaussian-Process qualifier routes its
most-uncertain accounts into the human approval queue, whose approve/reject decisions
become the next training labels.

**Pattern:** two-stage explainer (score composition, then a closing active-learning
loop that reuses the house style's ring-loop diagram language). Dark palette matching
the console. ~75s, on-screen captions, no narration.

## Beats
1. **Hook** (~7s) — "A score only matters if it does two things: drives an action +
   gets better over time." Sets up the two halves of the video.
2. **The Blend** (~14s) — three cards (RulesScorer — always on, offline; Claude —
   optional, gives a rationale not just a number; ONNX — optional, self-disables with
   no model file) converge into a "blended score = max(rules, weighted(onnx,
   claude))" card. Second demo, same section: a red "signal: unsubscribed" card
   arrows straight to "score = 0 -> DISQUALIFIED", bypassing the blend entirely — the
   hard floor no optimistic sub-score can rescue.
3. **fit x intent** (~12s) — two cards, FIT (firmographic/technographic: company
   size, industry, region, tech) vs INTENT (behavioral signals, time-decayed).
   Formula shown as plain text: "weight = 0.5^(age / 90 days)". Two bars: a 2-day-old
   signal at weight 0.98 beside a 6-month-old signal at weight 0.25 — same rule, same
   signal, very different contribution once it's stale.
4. **Calibration** (~11s) — raw score -> Python train-time sidecar (isotonic or Platt
   scaling) -> exports ONNX -> TypeScript inference (unchanged) pipeline. Then a
   0-100 number line with the real tier thresholds (25 / 50 / 75) so DISQUALIFIED /
   PARTIAL_FIT / FIT / STRONG_FIT read as honest, calibrated bands.
5. **The learning loop** (~14s, hero) — PREDICT (GP: mean + uncertainty) -> QUEUE
   (BALD picks the most-unsure accounts) -> HUMAN (approve / reject) -> LABEL
   (decision -> refit), curved return arrow labeled "uncertainty shrinks with every
   label". A token travels the ring while an "uncertain accounts" counter visibly
   drops from 12 to 4 — the cycle closing.
6. **Cold start** (~10s) — zero labels means the GP posterior IS the prior: five
   uniform, equally-uncertain accounts (all "?") arrow into one "human review" card —
   exactly right when the model knows nothing yet.
7. **Close** (~7s) — "The gate and the learner are the same loop." /
   RulesScorer -> HybridScorer -> GaussianProcessQualifier / offline, deterministic,
   every human approval is a training label.
