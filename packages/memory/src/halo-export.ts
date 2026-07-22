/**
 * halo-export.ts — exports the `approvals` hash chain (see `memory-repo.ts`)
 * in **halo-record's** "Halo Runtime Record" schema, so an EXTERNAL `halo
 * verify` (a separate Python CLI — process boundary only, never vendored;
 * see `docs/build-conventions.md` "Python tools ... run as sidecar
 * processes") can independently confirm the chain was never tampered with,
 * without trusting our code or our tests. research/10-sota-integration-
 * design.md §2.11 (B3): "add a `memory export-audit --format halo` ... The
 * internal welded chain stays untouched — we add an exporter, we don't
 * change the primitive."
 *
 * VERIFIED LIVE (2026-07-21) against github.com/bkuan001/halo-record @ main
 * (WebFetch of the README, the LICENSE file, and
 * `src/halo_record/halo-record.schema.json`; PyPI's rendered page did not
 * load for this fetcher, so the GitHub source — the `$id` target of the
 * schema itself — is the primary source here):
 *   - License: **Apache-2.0** (LICENSE file header read verbatim: "Apache
 *     License, Version 2.0, January 2004").
 *   - PyPI package `halo-record`, latest seen release **0.2.8** (2026-07-15).
 *   - Schema `title`: "Halo Runtime Record", `schema_version` is a const
 *     `"0.1"`.
 *   - Top-level **required** fields (quoted verbatim from the schema's
 *     `required` array): `schema_version`, `record_id`, `session_id`, `ts`,
 *     `action`, `integrity`. Top level is otherwise **permissive**
 *     (`additionalProperties` is not `false`), so an `mstack` extension
 *     object alongside the required envelope is schema-legal.
 *   - `integrity` sub-fields, all required: `alg` (const `"sha-256"`),
 *     `canon` (const `"rfc8785"`), `prev_hash` (hex sha256; "64 zeros for
 *     the first record" — this is a byte-for-byte match for our own
 *     `GENESIS_HASH`), `hash` (hex sha256 of the record with `integrity.hash`
 *     itself excluded).
 *   - Hash algorithm, quoted verbatim from the README: "take the record
 *     excluding `integrity.hash`, with `integrity.prev_hash` set to the
 *     previous record's hash; canonicalize with RFC 8785 (JSON
 *     Canonicalization Scheme); SHA-256 the bytes."
 *   - CLI surface includes `halo verify` (exit 1 = broken chain, exit 3 =
 *     empty chain) and `halo report` (renders a self-verifying HTML report).
 *
 * MAPPING NOTES / ASSUMPTIONS (the schema is shaped around AI-agent tool-call
 * events — subject/principal/agent/authority/action/outcome/findings/
 * signature — not human business-approval records, and it has **no**
 * `seq`/`index` field at all: chain order is carried purely by the
 * prev_hash -> hash linkage. This mapping is a good-faith best fit, not a
 * byte-verified spec conformance claim beyond the fields quoted above):
 *   - `record_id`      <- `approval.id`
 *   - `session_id`     <- constant `"mstack-approvals"`. Our chain is one
 *     continuous append-only log for the whole warehouse, not scoped to a
 *     conversational session — halo's "session" concept has no natural
 *     analogue here, so a stable constant is the honest choice over
 *     fabricating a per-export session id.
 *   - `action.type`    <- `"write"` (an Approval gates a write/send action —
 *     see `@mstack/runtime`'s `dispatchDraft`).
 *   - `action.category`<- `"safety"` (closest fit for a human-in-the-loop
 *     gate among the observed category values security/safety/reliability/
 *     privacy).
 *   - `action.authorization` <- `approval.decision` mapped: `"approve"` and
 *     `"edit"` -> `"human_approved"`, `"reject"` -> `"denied"` (halo's
 *     authorization enum has no third "edited" state). The ORIGINAL decision
 *     string is never lost — it is preserved verbatim in `mstack.approval`.
 *   - `integrity.prev_hash` / `integrity.hash` <- computed fresh, in HALO's
 *     algorithm (not ours — see `canonicalizeRfc8785` below). This is the
 *     load-bearing field for external verification.
 *   - `mstack.{seq,approval}` — an extension object (schema-legal per the
 *     permissive top level) carrying our internal `seq` and the full
 *     original `Approval` losslessly. NOTE: `mstack.approval.hash` /
 *     `.prevHash` are OUR internal chain's hash values (a different
 *     algorithm entirely — see `memory-repo.ts`'s `appendApproval`), not to
 *     be confused with this record's own `integrity.hash` / `.prev_hash`.
 *
 * NOT independently re-verified beyond the fields quoted above: nested
 * requiredness inside `action` past `type` was read via a fetch/summarize
 * pass rather than a byte-exact schema diff, so it carries less certainty
 * than the top-level `required` array and `integrity`'s four keys (both of
 * which were confirmed with a direct, verbatim-requesting fetch). If a real
 * `halo verify` run ever rejects a field here, that's the signal to tighten
 * this mapping — the isolated-exporter design means such a fix never touches
 * `appendApproval` / `verifyAuditChain`.
 *
 * Sources: https://github.com/bkuan001/halo-record (Apache-2.0) ·
 * https://pypi.org/project/halo-record/0.2.8/
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Approval, GENESIS_HASH, sha256Hex } from "@mstack/core";

import type { MemoryRepo } from "./memory-repo.js";

/* ───────────────────────── halo-record schema types ───────────────────── */

export interface HaloIntegrity {
  alg: "sha-256";
  canon: "rfc8785";
  /** Hex SHA-256 of the previous record's `integrity.hash`; 64 zeros for the first record. */
  prev_hash: string;
  /** Hex SHA-256 of this record, canonicalized per RFC 8785, with `integrity.hash` itself excluded. */
  hash: string;
}

export interface HaloAction {
  type: "write";
  category: "safety";
  authorization: "human_approved" | "denied";
  /** Redacted human-readable summary (halo-record's "input: redacted summary" shape) — never raw drafted content. */
  summary: string;
}

/** mstack extension — schema-legal (halo-record's top level does not set
 *  `additionalProperties: false`). Carries our internal `seq` (halo has no
 *  ordering field of its own) and the original `Approval` losslessly. */
export interface HaloMstackExtension {
  seq: number;
  approval: Approval;
}

/** One "Halo Runtime Record" per halo-record's schema v0.1 (title "Halo Runtime Record"). */
export interface HaloRecord {
  schema_version: "0.1";
  record_id: string;
  session_id: string;
  ts: string;
  action: HaloAction;
  integrity: HaloIntegrity;
  mstack: HaloMstackExtension;
}

type HaloRecordSansHash = Omit<HaloRecord, "integrity"> & {
  integrity: Omit<HaloIntegrity, "hash">;
};

/* ───────────────────────── RFC 8785 canonicalization ───────────────────── */

/**
 * A practically-RFC-8785-compliant canonicalizer for the shapes this
 * exporter produces: strings, plain finite numbers, booleans, null, and
 * nested objects/arrays — the `Approval` schema (`@mstack/core`) contains no
 * floating-point fields and no non-ASCII-normalization-sensitive content, so
 * this is safe for that domain today. Node's `JSON.stringify` already
 * serializes numbers via the ECMAScript `Number::toString` algorithm and
 * strings via the standard minimal-escaping `QuoteJSONString` algorithm —
 * RFC 8785 §3.2.2 mandates exactly those two algorithms — so recursively
 * sorting object keys before calling `JSON.stringify` with no indentation
 * (no extra whitespace) is sufficient for hash-equivalence with a
 * conformant external RFC 8785 implementation FOR THIS DOMAIN.
 *
 * This is a deliberately SEPARATE function from `memory-repo.ts`'s internal
 * `canonicalJson` — same technique, decoupled contract, so a change to
 * either hash scheme can never silently affect the other. See the file
 * header for why the internal primitive is intentionally not reused here.
 *
 * NOT independently verified against exotic inputs (very large integers,
 * `-0`, unicode requiring normalization) — none of which `Approval` can
 * produce today. Revisit if this exporter ever canonicalizes a payload
 * shape beyond `Approval`.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic, key-sorted JSON serialization matching halo-record's RFC 8785 canonicalization for this package's payload shapes (see doc-comment above). */
export function canonicalizeRfc8785(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/* ───────────────────────────── mapping ─────────────────────────────────── */

/** A short, redacted summary — never more than what `Approval` already
 *  stores (id / decision / actor / optional note), matching halo-record's
 *  "input: redacted summary" shape for the action object. */
function summarizeApproval(approval: Approval): string {
  const target = approval.draftId
    ? `draft ${approval.draftId}`
    : approval.reviewId
      ? `review ${approval.reviewId}`
      : "an unspecified target";
  const noteSuffix = approval.note ? ` — ${approval.note}` : "";
  return `${approval.actor} ${approval.decision}d ${target}${noteSuffix}`;
}

function toHaloRecord(approval: Approval, seq: number): HaloRecord {
  const authorization: HaloAction["authorization"] =
    approval.decision === "reject" ? "denied" : "human_approved";

  const sansHash: HaloRecordSansHash = {
    schema_version: "0.1",
    record_id: approval.id,
    session_id: "mstack-approvals",
    ts: approval.ts,
    action: {
      type: "write",
      category: "safety",
      authorization,
      summary: summarizeApproval(approval),
    },
    integrity: {
      alg: "sha-256",
      canon: "rfc8785",
      prev_hash: approval.prevHash,
    },
    mstack: { seq, approval },
  };

  const hash = sha256Hex(canonicalizeRfc8785(sansHash));

  return {
    ...sansHash,
    integrity: { ...sansHash.integrity, hash },
  };
}

/* ────────────────────────────── public API ─────────────────────────────── */

/**
 * Reads the `approvals` chain (oldest first) and maps it into halo-record's
 * schema. Read-only against `memory` — uses only the public `query()` escape
 * hatch, never touches `appendApproval`/`verifyAuditChain` internals.
 */
export async function exportAuditHalo(memory: MemoryRepo): Promise<HaloRecord[]> {
  const rows = await memory.query<{ seq: unknown; data: string }>(
    "SELECT seq, data FROM approvals ORDER BY seq ASC",
  );

  const records: HaloRecord[] = [];
  for (const row of rows) {
    const approval = Approval.parse(JSON.parse(String(row.data)));
    records.push(toHaloRecord(approval, Number(row.seq)));
  }
  return records;
}

/** `exportAuditHalo` + write the JSON array to `path` (creating parent dirs).
 *  Pretty-printed for human/CI readability — the hash computation itself is
 *  always over the compact canonical form, never the pretty-printed bytes. */
export async function writeHaloAudit(memory: MemoryRepo, path: string): Promise<HaloRecord[]> {
  const records = await exportAuditHalo(memory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(records, null, 2) + "\n", "utf8");
  return records;
}

/**
 * Recomputes and checks an exported chain per halo-record's documented
 * algorithm (see file header) — a self-check mirror of what the EXTERNAL
 * `halo verify` CLI does, so this exporter is testable without depending on
 * that separate Python process being installed. This is NOT a substitute for
 * actually running `halo verify` before trusting an export in production —
 * it reimplements only the documented hash-chain algorithm, not halo-record's
 * full JSON-schema validation.
 */
export function verifyHaloChain(records: readonly HaloRecord[]): boolean {
  let expectedPrev = GENESIS_HASH;
  for (const record of records) {
    if (record.integrity.prev_hash !== expectedPrev) return false;
    const { hash, ...sansHash } = record.integrity;
    const recomputed = sha256Hex(canonicalizeRfc8785({ ...record, integrity: sansHash }));
    if (recomputed !== hash) return false;
    expectedPrev = hash;
  }
  return true;
}
