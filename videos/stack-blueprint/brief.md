# stack-blueprint — storyboard

**Takeaway:** the contracts that *determine* the code — type shapes, seam signatures,
pipeline I/O, and the exact algorithms/invariants — dense enough that the implementation
is inferable from the video alone. "Pause-to-study" panels.

**Pattern:** contract/spec walkthrough. Monospace code panels on dark. ~67s.

## Beats (each = one load-bearing contract)
0. Title — "the contracts that determine the code".
1. **core domain model** — Signal/Account/Draft/Approval with the fields that carry behavior
   (Draft.status enum; Approval.prevHash/hash).
2. **core 5 seams** — the interface signatures; OutreachChannel.dispatch REQUIRES an Approval.
3. **reviewer != generator** — ReviewResult has no prose field; Finding.recommendedChange is an
   instruction; the rubric (changes→score). The type makes generation impossible.
4. **review pipeline** — reviewAsset's 6 steps with I/O (segment → scanDeterministic → extract →
   retrieve[LanceDB] → judge[Opus] → scoreForChanges).
5. **runAgent** — the full signature + the tool-use loop + Zod safeParse + one re-ask.
6. **account-intel** — activateAccount: resolve → rank → swarm (SDR/Copywriter/Router I/O) →
   AccountDecision + Draft; SDR cites only input signalIds.
7. **scoring + enrichment** — HybridScorer blend + disqualifier floor; mergeEnrichment trust order.
8. **memory audit** — appendApproval's hash formula; verifyAuditChain.
9. **dispatch gate** — dispatchDraft: verify persisted draft + real hash-chained approval; the
   exact assertions; the one send path.
10. **offline-first + close** — every seam has a sample default; swap→real to go live.

Design note: a single video can't show every field/test; it shows the *determining* contracts
and decisions, from which a competent implementer infers the rest.
