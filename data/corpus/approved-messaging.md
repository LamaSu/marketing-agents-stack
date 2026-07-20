# KLZ Partner Content — Approved Messaging

**Status:** sample north-star corpus (fictional vendor "KLZ" — a stand-in for Anthropic,
per `research/04-slides-and-demos.md`). This document is the human-readable source for
the reviewer's RAG corpus: it gets chunked and embedded into LanceDB (`bge-small-en-v1.5`
via `@xenova/transformers`) so the claim-drift reviewer can retrieve supporting passages
for any claim in a submitted asset. The machine-checkable rule rows that pair with this
document live in `data/corpus/guidelines.json`.

This is a **sample/demo corpus only** — every name, quote, and statistic below is
synthetic, written for this fixture set. It is not a real vendor's messaging.

---

## 1. Positioning

KLZ Orchestrate is the agentic orchestration layer that lets partners connect
Claude-native agents to their own systems of record — without rebuilding their data
infrastructure first. It is built for teams who already have a CRM, a warehouse, and a
product analytics stack, and want an agent layer that reasons over what's already there
instead of asking them to migrate onto a new platform.

The competitive frame we use internally and in partner-facing materials: **the advantage
isn't more AI, it's better decision loops.** KLZ Orchestrate exists to shorten the loop
between "a signal happened" and "the right person took the right action" — for both
inbound account activation and outbound content governance.

## 2. What KLZ Orchestrate does (approved capability language)

KLZ Orchestrate automates document-heavy workflows across finance, legal, and operations
by combining Claude's reasoning with your existing systems of record. Two reference
workflows ship out of the box:

- **Claim-drift / brand review.** KLZ Orchestrate's claim-review agent checks
  partner-submitted content against KLZ's approved messaging corpus and brand rules, and
  returns categorized findings with a recommended change for each. **It does not rewrite
  or generate replacement marketing copy** — it is a reviewer and a tracker, not a content
  generator. A human always drafts (or edits) the actual replacement language.
- **Account intelligence / activation.** KLZ Orchestrate ingests product usage, CRM,
  campaign, and intent signals for an account, scores it as an ICP fit, and runs a small
  swarm of tightly-scoped agents to surface relevant signals, resolve the buying
  committee, and draft one personalized outreach message — which a human approves before
  it sends.

When describing either workflow, prefer concrete descriptions of what the system does
over comparative or superlative language. "Automates document-heavy workflows across
finance, legal, and operations" is approved language. "No other platform on the market
comes close" is not — see §5.

## 3. Approved customer proof points (cited)

Quantitative claims are only usable when they carry the citation below (or a citation to
a more recent equivalent KLZ publishes). Do not restate the number without the source.

> In KLZ's Q2 2026 customer survey (published at klz.com/reports/q2-2026), joint
> customers reported a **median 35% reduction in manual workflow processing time**
> across a sample of 40 partner deployments. Results vary by environment and
> integration depth.

> KLZ's published benchmark (klz.com/benchmarks/agentic-review-2026) found that
> partner-submitted content using KLZ Orchestrate's review agent reached publish-ready
> status in a **median of 1.4 review cycles, down from 3.2 cycles** under manual review.

If a partner has its own customer result to cite, the correct framing is "customers have
reported..." with a link to the partner's own published source — never "guarantees" or
"ensures," and never a bare number with no source at all.

## 4. Partnership & tiers

KLZ's partner program is built on three tiers — **Registered**, **Select**, and
**Elite** — each unlocking deeper co-marketing, technical enablement, and joint
go-to-market support as partners demonstrate integration depth and customer outcomes.

**Badge usage (tier-gated — this is a hard rule, not a style preference):**

| Tier | Badge / designation | Notes |
|---|---|---|
| Elite | "Powered by KLZ Orchestrate" | Full badge + lockup permitted on marketing site, docs, and collateral |
| Select | "KLZ Select Partner" | Text designation only; the "Powered by KLZ Orchestrate" badge is Elite-exclusive |
| Registered | *(none)* | A plain-text mention of a "KLZ integration" is fine; no badge or lockup of any kind |

## 5. Language to avoid (and what to say instead)

- Avoid **"guarantee," "guaranteed," "ensures," "promise"** for outcomes or ROI. Instead:
  "customers have reported [cited result]."
- Avoid unqualified superlatives — **"no other platform comes close," "best-in-class,"
  "unmatched," "unrivaled," "#1," "world's best."** Instead, describe the capability
  concretely (see §2).
- Avoid any **quantitative claim without a citation** (a percentage, an "Nx" multiplier,
  a dollar figure). Cite a published source or remove the figure.
- Avoid quoting **any KLZ employee** other than the two spokespeople in §6 without
  written, piece-specific approval from KLZ Partner Marketing.
- Avoid any reference to **unannounced KLZ products, features, internal codenames, or
  launch dates.** Roadmap communications come from KLZ only, on KLZ's own channels.

## 6. Approved spokespeople & quotes

The only KLZ employees approved as quote sources in partner content, absent
piece-specific written approval, are:

- **Dana Whitfield**, VP Partnerships
- **Sam Okafor**, Head of Ecosystem

Approved quotes (partners may use these verbatim, with attribution, without requesting
further approval):

> "We built KLZ Orchestrate so builders like our partners can ship agentic workflows
> without reinventing infrastructure." — Dana Whitfield, VP Partnerships, KLZ

> "Our best integrations come from partners who understand their customers' workflows
> better than we ever could." — Sam Okafor, Head of Ecosystem, KLZ

Quotes from any other KLZ employee — including executives such as the CEO or CMO —
require written, per-piece approval from KLZ Partner Marketing before publication. This
applies even if the quote sounds plausible or on-message; approval is about
authorization, not accuracy.

## 7. Trust & governance framing (approved)

KLZ Orchestrate never auto-sends partner or customer communications. Every agent-drafted
action — an email, an export, an outreach message — lands in a pending state for a human
to review, edit, or approve before it goes out. This is true in both "copilot" and
"autopilot" modes; autopilot only changes who approves low-tier, non-strategic sends by
policy, and every send is still logged in a hash-chained audit trail.

## 8. Roadmap discipline

Do not reference unannounced KLZ products, features, or launch dates in partner content
— including internal codenames. This is true even if the information is accurate or was
mentioned informally; roadmap communications are a KLZ-only channel, timed against a
public announcement. If a partner asset wants to talk about "what's next," redirect it to
what KLZ has already shipped and publicly announced.
