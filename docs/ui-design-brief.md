# Marketing Agents Stack — Web UI design brief (console + portal)

Shared design system for the two Fastify apps' `public/` frontends. Both apps derive
their CSS from the same tokens below so console and portal read as **one product**.
Offline-first, keyless, no framework, no build step, no CDN — vanilla HTML/CSS/JS only.

## The thesis (what these UIs are about)

This is an **autonomous GTM engine that cannot act without a human turning the key.**
Signals come in, the system scores/decides/drafts — but **every send is a `pending`
draft a human approves.** So the design is a **control bench**, not a marketing
dashboard: a calm, precise operator surface where the *approval gate* is the hero.
It runs **locally, offline, with no API key** — a local instrument panel, not a cloud SaaS.

- **console** = the operator's instrument panel: the funnel, accounts, scores, drafts. Read + activate.
- **portal** = the approval bench: review AI-drafted partner content, then approve/reject the gated sends.

## Signature element (the one memorable thing)

**The approval gate as a "held" action.** A pending draft/review renders as a card that
visibly *awaits your decision*: it shows the AI's rationale + a calibrated confidence
read + the drafted content, and approving it is a deliberate **two-step commit
(arm → confirm)** so sending feels like turning a key — with an **undo** affordance for a
few seconds after. Same component language in both apps. This embodies "the human is the
gate." Spend the boldness here; keep everything else quiet.

## Design tokens (copy this `:root` block verbatim into both apps' CSS)

Identity = **warm "needs you" signal on a cool graphite bench, with all data/IDs/statuses
set in monospace** (the instrument-readout feel). This is deliberately NOT the AI-default
cream-serif-terracotta / black-acid-green / broadsheet looks.

```css
:root {
  /* ground + surface — a cool, low-glare workbench */
  --ink:        #14171C;   /* near-black: text + structure */
  --ink-soft:   #5A626E;   /* secondary text */
  --ground:     #E6E8EC;   /* app background (cool graphite-tint) */
  --surface:    #FFFFFF;   /* cards / panels */
  --surface-2:  #F4F5F7;   /* insets, table stripes */
  --line:       #D2D6DD;   /* hairlines (1px) */
  --line-2:     #E4E7EB;

  /* semantic states — one warm gate hue is the signature */
  --gate:       #B7791F;   /* AMBER — "awaiting your decision" (the signature accent) */
  --gate-tint:  #FBF3E2;   /* amber wash for pending surfaces */
  --commit:     #0F766E;   /* TEAL — approved / sent / committed (calm) */
  --commit-tint:#E6F2F0;
  --reject:     #B4322A;   /* muted brick — returned / rejected (used sparingly) */
  --focus:      #2563EB;   /* keyboard focus ring only */

  /* type — a tight system grotesque for prose; MONO for all data/IDs/status/counts */
  --font-sans: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;

  /* scale */
  --step--1: 0.8125rem;  --step-0: 0.9375rem;  --step-1: 1.125rem;
  --step-2: 1.5rem;      --step-3: 2.25rem;     --step-4: 3.25rem;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 40px; --sp-7: 64px;
  --radius: 6px; --radius-lg: 10px;
  --shadow: 0 1px 2px rgba(20,23,28,.06), 0 4px 16px rgba(20,23,28,.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink:#EAECEF; --ink-soft:#98A2B3; --ground:#0E1116; --surface:#161A21;
    --surface-2:#1C222B; --line:#262D38; --line-2:#20262F;
    --gate:#E0A93C; --gate-tint:#2A2312; --commit:#3FB6A8; --commit-tint:#122622;
    --reject:#E06A61; --focus:#5B8DEF;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
  }
}
```

Rules that make it feel like an instrument, not a template:
- **Mono for data.** Every id, status, count, score, tier, timestamp, funnel number, and
  the funnel/table figures use `--font-mono`. Prose (headings, descriptions, microcopy)
  uses `--font-sans`. This split is the identity — hold it consistently.
- **One accent.** `--gate` (amber) appears ONLY on the "needs a human" state — pending
  drafts, the arm/confirm control, the count of things awaiting you. Don't spray it around.
- **Hairlines, not boxes.** Structure with 1px `--line` rules and generous whitespace;
  `--radius` small; shadows barely there. Zero neon, zero gradients-for-decoration.
- **Structure encodes the loop.** The left rail is the real sequence
  (console: Funnel → Signals → Accounts → Drafts; portal: Queue → Review → Approvals →
  Ledger). The order carries meaning (signal→decision→action) — so numbering/sequence is
  earned here, unlike a generic dashboard.

## Motion

Restrained. A `arm→confirm` approve has one satisfying "commit" micro-interaction (the
card settles/locks, the status flips to `sent` in teal). Respect
`@media (prefers-reduced-motion: reduce)` — no transitions then. No scroll-jank, no
ambient loops.

## Microcopy (from the design writing guidance)

- End-user language, active voice: the button says **"Approve & send"**, the toast says
  **"Sent."** Reject says **"Return for changes."** Same verb through the whole flow.
- Empty states are invitations, not mood: e.g. console drafts empty →
  *"No drafts awaiting approval. Run `mstack demo` or activate an account to generate one."*
- Errors explain what happened + how to fix, in the interface's voice. Never apologize.
- Say what things are by what the operator controls: "Awaiting your approval," not
  "pending draft rows."

## Offline-first (hard constraints — do not violate)

- **No CDN, no external requests.** No `fonts.googleapis.com`, no CDN `<script>`/`<link>`.
  Use the system font stacks above. If a display face is truly wanted, self-host ONE
  `.woff2` in `public/fonts/` and `@font-face` it locally — but the system stack is the
  default and is fine.
- **No build step, no framework.** Vanilla `index.html` + `app.css` + `app.js` (+ small
  modules if helpful) served straight from `public/`. No bundler, no npm deps.
- **The page fetches only its own `/api/*`.** All data is same-origin JSON.
- Quality floor, unannounced: responsive to mobile, visible keyboard focus (`--focus`
  ring), reduced-motion respected, semantic HTML + ARIA on interactive controls.

## API cheatsheet — bind `fetch()` to THESE exact fields

### console (default port 4320; `apps/console/public/`)
- `GET /api/health` → `{ ok: bool, mode: "live"|"offline" }`
- `GET /api/stats` → `deriveStats(memory)` — the funnel/rollup counts (READ `deriveStats` in
  `apps/console/src/server.ts` for exact field names before rendering the funnel).
- `GET /api/signals?limit=40` → `{ mode, signals: Signal[] }` (Signal: `id, ts, source, kind,
  actor{userId?,anonId?,email?,company?,handle?}, action?, ...` — read `recentSignals`).
- `GET /api/accounts` → `{ mode, accounts: Account[] ranked }` (Account: `id, domain, name,
  firmographic{employees,industry,region,tech[]}, score, tier, buyingCommittee[], ...` —
  read `listAccountsRanked`).
- `POST /api/activate` `{domain, name?, mode?}` → `{ mode, decision{accountId, ts, score,
  tier, relevantSignals[], buyingCommittee[], nextBestAction{action,channel,targetMember},
  rationale, byAgent, agentMode}, draftId, draftSubject, draftBody }`.
- `GET /api/drafts` → `{ drafts: [{id, kind, refId, subject, body, status, createdAt, createdBy}] }`.
- `POST /api/drafts/:id/approve` → `{ ok, dispatched, draftId, outcome, auditVerified }`
  (404 if missing, 409 if already dispatched).

### portal (default port ~4321; `apps/portal/public/`)
- `GET /api/mode` → `{ mode, detail }`.
- `GET /api/partners` → `[{ partnerId, partnerTier }]`.
- `GET /api/sample-draft?partnerId=` → a ReviewRequest `{ partnerId, partnerTier,
  contentTitle, contentType, content }`.
- `POST /api/review` `{ReviewRequest}` → `{ review: Review, draftIds:{partnerEmail, reviewExport} }`.
- `GET /api/reviews` → `[{ id, partnerId, partnerTier, contentTitle, contentType, createdAt,
  verdict:"APPROVED"|"RETURNED", score(1-5), findingsCount }]`.
- `GET /api/reviews/:id` → `{ review: Review{...findings:[Finding]}, meta, drafts:{partnerEmail, reviewExport} }`
  (Finding: `id, category, required, quote, recommendedChange, supportingPassageId, detectedBy, severity`).
- `GET /api/drafts` → `Draft[]` (full: `id, kind, refId, subject, body, channel, status, createdBy, createdAt`).
- `POST /api/drafts/:id/approve` → `{ outcome, draft }`.
- `GET /api/internal` → `{ partners:[{partnerId, approved, returned, total}], totals:{...} }`.

## Per-app scope

**console** — a single-page instrument panel:
1. **Funnel** (hero): the 8-stage funnel from `/api/stats` as a horizontal flow with
   stage counts (mono) + conversion between stages. Use the `dataviz` discipline for the
   funnel bars — one system, accessible in light+dark, the placeholder palette swapped for
   these tokens.
2. **Accounts** table (ranked): domain, score, tier (tier as a small mono chip), industry,
   next-best-action. Click → activate.
3. **Signals** stream: recent signals (source · kind · actor · action · ts) in a compact
   mono ledger.
4. **Drafts awaiting approval**: the gate cards (amber). Approve → teal `sent`, undo window.

**portal** — the approval bench:
1. **Queue** (hero): drafts + reviews awaiting a human — the gate cards.
2. **Review** a partner asset: pick partner → load sample → submit for review → see the
   verdict (score 1–5, APPROVED/RETURNED) + the findings (each finding = category · quote ·
   recommended change · severity). The findings list is the "why" behind the gate.
3. **Approvals**: pending drafts (partner_email / review_export) → arm→confirm approve.
4. **Ledger**: the `/api/internal` approved/returned tally per partner (mono table).

Borrow atelier's **trust-lifecycle pattern** for the gate: show rationale + calibrated
confidence *before* approve, offer undo *after*. (Pattern only — not atelier's runtime.)
