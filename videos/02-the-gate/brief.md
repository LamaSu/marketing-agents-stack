# 02-the-gate — storyboard

**Takeaway (one sentence):** Nothing sends without a human — `dispatchDraft` is the
one gated path to `dispatched`, guarded by four checks, a win-once atomic claim, and a
tamper-evident ledger.

**Pattern:** guardrail / state-machine walkthrough (the gate itself is the hero). Dark
palette to match the console + the `marketing-agents-loop` video. ~87s, on-screen
captions, no narration.

## Beats
1. **Hook** (~13s) — title card "The Gate" / "why nothing sends without you"; then an
   Agent card feeds a Draft card (`status: "pending"`); a red, crossed-out arrow shows
   the Draft can't reach the outside world directly. Caption: every outbound action
   becomes a Draft — nothing leaves on its own.
2. **One door in** (~11s) — three producer cards (Reviewer, Account-Intel swarm,
   Cadence engine) all funnel into a single `dispatchDraft()` gate card via converging
   arrows. Caption: `dispatch.test.ts` greps the source for exactly one `.dispatch(`
   call site.
3. **Four locks on that door** (~28s, hero) — the gate reappears with four small
   "lock" chips below it. Each in turn: an attempt arrow knocks on the gate (grow +
   flash), the gate refuses it (chip turns red, crossed out, reason captioned below) —
   in order: No Approval → Wrong draft / not `approve` → Content changed since approval
   (contentHash mismatch) → Forged Approval (no real row in the ledger). Closing
   caption: all four must hold, every single time, before the channel is ever called.
4. **Win-once** (~13s) — state machine `approved → dispatching → dispatched` drawn as
   three linked cards; caption names the atomic `UPDATE ... WHERE status='approved'`
   claim. Two concurrent callers both reach for the same draft — one wins (the existing
   transition arrow lights up), the other is refused and crossed out. A curved arrow
   then shows a channel failure reverting `dispatching → approved`, so a retry can
   still send.
5. **The ledger** (~12s) — four hash-chained Approval blocks in a row, linked by
   arrows, with the formula `hash = sha256(prevHash + canonicalJson(record))` above.
   Tampering with block #2 (flash + red recolor + cross-out) breaks every downstream
   link (arrows turn red); caption: `verifyAuditChain()` → FAILS.
6. **Honest close** (~10s) — two plain, unhyped caveats mirroring `SECURITY.md`:
   tamper-evident, not cryptographically signed (proves order, not WHO approved it);
   the only send path in the normal flow (in-process code holding a repo handle is
   trusted by design). Ends on the thesis line: "A human approves every send."
