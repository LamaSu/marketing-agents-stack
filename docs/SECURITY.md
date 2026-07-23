# Security posture (honest)

This stack was security-audited across two rounds by an independent, cross-family model
(sol / GPT-5.6). This doc states the **threat model**, what is **actually guaranteed**, and
the **residuals we have not closed** — plainly, so no one over-trusts it.

## Threat model

The stack is an **offline-first, keyless, single-operator local tool**. The operator runs it
on their own machine; there is no LLM in the request path and no multi-tenant boundary.
Therefore **in-process code is trusted** — anything holding a `MemoryRepo` handle, the raw
`query()` escape hatch, or a channel's `dispatch()` method is, by definition, the operator's
own code and can do whatever the operator can (including `fetch()` anything).

What the guardrails actually defend against, then, is **not** a malicious in-process
adversary. They defend against:
- **accidental / agent-driven ungated sends** in the normal product flow (an agent, a
  workflow, or a bug cannot send without a human-approved, content-bound `Approval`), and
- **tamper-evidence** — after-the-fact detection of edits/reorders of the audit ledger.

If you deploy this as a **multi-tenant or network-exposed service**, that threat model no
longer holds and the residuals below become exploitable. See "Hardening for that case."

## What is guaranteed (in the normal flow)

- **One send path.** `runtime/dispatch.ts#dispatchDraft` is the only path from `Draft` to
  `dispatched` in the normal flow, grep-guarded by a test asserting exactly one channel call
  site. It refuses any draft lacking a matching **approved** `Approval`.
- **Win-once atomic claim.** Dispatch flips `approved → dispatching` with a single conditional
  `UPDATE … WHERE status='approved' RETURNING id`; only the winner calls the channel, then
  `dispatching → dispatched` on success or **reverts to `approved`** on channel failure (so a
  legitimate retry can resend, and a crash leaves `dispatching`, which a fresh dispatch
  refuses). Closes the concurrent double-send race and the retry double-send.
- **Content binding.** An `Approval` carries a `contentHash` of the approved draft's
  dispatch-relevant fields, pinned at approve time; dispatch refuses if the persisted draft's
  content changed since approval (approve-X-then-send-Y is blocked). The send path requires a
  `contentHash`.
- **Tamper-evident ledger.** Approvals are hash-chained (`hash = sha256(prevHash +
  canonicalJson(record))`), hashed over the canonical parsed form so extra/stray fields can't
  desync stored-vs-recomputed. `verifyAuditChain()` detects any edit or reorder of retained
  rows. `auditHead()` exposes `{count, headHash}` for external truncation-anchoring.
- **Credential broker.** The agent only ever gets `proxyCall()` — never the raw secret.
  `proxyCall` enforces the provider's registered `baseUrl` (scheme/host/port + segment-aligned
  path, userinfo rejected, encoded-slash normalized) **before the secret is loaded**, refuses
  secret-in-query-param injection, and does not follow redirects with the secret attached.
  `resolve()` is scoped to the provider's registered key names.
- **DPoP (RFC 9449).** Proofs bind `htm/htu/jti/iat`; replay is rejected by default via an
  atomic, TTL-bounded jti consumption that never evicts an unexpired jti; an invalid proof
  never consumes a jti and `verifyDpopProof` never throws.
- **CRM sync boundary.** `CrmSync` can only perform record-update actions (allowlist:
  update/upsert/create on a record noun, any send-intent substring hard-refused even under the
  `dangerouslyAllowAnyAction` opt-out), and projects `Decision`/`Outcome` through their zod
  schema before the wire, so it cannot become a covert send path or leak smuggled fields.

## Residuals — NOT closed (know these before trusting it beyond a local tool)

1. **In-process code is trusted.** A caller with a `MemoryRepo` handle can `appendApproval` +
   flip a draft's status + run arbitrary `query()` and manufacture a "valid" approval, or call
   a channel's public `dispatch()` directly with forged objects. This is inherent to a
   single-process app and is *by design* under the threat model above.
2. **Approvals are tamper-EVIDENT, not cryptographically SIGNED.** `actor` is caller-provided
   text; the chain proves internal consistency + ordering, not *who* authorized a record.
   Real per-operator signing (we now ship DPoP keys that could do it) is a follow-up.
3. **Truncation needs an external anchor.** `verifyAuditChain()` alone cannot detect deletion
   of the newest rows. Use `auditHead()` + the halo-record export as a durable external pin;
   the dispatch path does not yet assert against a pinned head automatically.
4. **Unauthenticated `proxyCall` is an open relay (SSRF).** Secret *exfiltration* is closed,
   but a call that injects no secret is not URL-restricted — a network-exposed deployment
   should add an SSRF allowlist.
5. **DPoP multi-process.** The default jti store is single-process in-memory; a multi-process
   deployment must supply a shared atomic (e.g. Redis) `JtiStore`.

## Hardening for a network-exposed / multi-tenant deployment

- Run the `credentials` package behind a real process/service boundary; never hand untrusted
  code a `MemoryRepo` handle or the `query()` escape hatch.
- Add cryptographic signing of approvals (bind the operator's DPoP key into `Approval`).
- Externally pin `auditHead()` (or the halo export) and assert it on the dispatch path.
- Add an SSRF allowlist to `proxyCall`; move `MemoryRepo` to the Postgres backing (designed
  behind the interface) for genuine multi-writer atomicity.

_Audit trail: two rounds, sol/GPT-5.6, findings triaged (in-process-adversary findings kept as
documented residuals; real bugs + regressions fixed with regression tests). Re-run
`codex-offload review` to re-audit._
