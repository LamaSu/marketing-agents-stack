# 05-sequences-and-analytics — storyboard

**Takeaway (one sentence):** Multi-step cadences that still can't send — and the
funnel that proves what worked.

**Pattern:** contrast beat (hero) + data-flow, matching marketing-agents-loop's
dark palette and card() vocabulary. ~79s, on-screen captions, no narration.

## Beats
1. **Hook** (~8.5s) — "One-off sends aren't a GTM motion" → "you need CADENCES";
   two grey chips name what Outreach/Salesloft sell; closes on "here's that —
   with the gate intact".
2. **A Sequence** (~8.5s) — `mstack sequence start figma.com` runs; two ordered
   step cards appear (Step 1 "opener" day 0, Step 2 "follow-up" day 3, both
   `stopIfReplied`) linked by an arrow; the figma.com account card enrolls into
   step 1.
3. **The critical difference** (~13s, hero) — side-by-side contrast: left
   ("Outreach/Salesloft") a step goes straight to a red "SENT — auto" chip with
   "no human in the loop"; right ("mstack sequences") the same step renders a
   gold "Draft — PENDING" chip and stops at a green "a human approves / the ONE
   send path" gate. Caption: a source-scan test proves zero dispatch/approve
   call sites in `runner.ts`.
4. **Waiting durably** (~8s) — an `Executor` card branches to `DirectExecutor`
   (offline default, in-process) and `HatchetExecutor` (opt-in, crash-resume);
   caption: `mstack sequence tick` advances whatever is due.
5. **The return leg** (~7.5s) — `mstack ingest-outcomes` brings in an `Outcome`
   card (replied/meeting) that fans out to two results: the sequence card turns
   red "STOPPED — no more follow-ups" and a green "qualifier" card gets
   "labels for train-qualifier".
6. **The funnel** (~18.5s) — `mstack report` header + an illustrative-data
   disclaimer, then: (a) an 8-bar funnel (signals → scored → decisions →
   drafts → approved → sent → replied → meeting) with counts and stage-to-stage
   conversion percentages narrowing left to right; (b) a 4-bar "conversion by
   tier" comparison (STRONG_FIT/FIT/PARTIAL_FIT/DISQUALIFIED meeting rates);
   (c) a review-outcomes caption (82% approval rate; top claim-drift categories
   `guaranteed_outcome`, `unapproved_superlative`).
7. **Delivery — CrmSync** (~8.5s) — a `CrmSync` card (score/decision/outcome)
   pushes into Salesforce and HubSpot cards; caption shows the allowlist
   contrast: `UPDATE_CONTACT` allowed vs `SEND_EMAIL` refused — record-update
   actions only, never a second send path.
8. **Close** (~6.5s) — "Cadence, measurement, and CRM delivery — with a human
   on every send"; "Marketing Agents Stack • offline, deterministic, open".
