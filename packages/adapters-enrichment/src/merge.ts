/**
 * mergeEnrichment — combine multiple providers' `EnrichmentRecord`s for the SAME
 * company into one record with PER-FIELD provenance. Trust order (highest first):
 * the CC0 registries (`wikidata`/`gleif`/`edgar`) and the offline `sample` fixture >
 * `llm-web` > everything else (opt-in paid vendors — not shipped in this package).
 * Conflicts are resolved BY TRUST, NEVER AVERAGED (research/06-architecture.md §3.2,
 * §6): the highest-trust record that has a non-empty value for a field wins that
 * field outright, and its source is written into `provenance`. Ties within the same
 * trust tier resolve by input order (first record in the array wins) — a
 * deterministic, documented tie-break; the cross-tier trust order is the thing the
 * architecture doc actually specifies.
 *
 * Fields are treated as ATOMIC — employees/industry/region/tech/contacts/name each
 * come wholesale from ONE winning source, never unioned or averaged across sources —
 * because `Provenance` (packages/core `schemas.ts`) maps one field name to exactly ONE
 * source string. That schema shape is why there's no "merge tech arrays together"
 * behavior here: it would leave `provenance.tech` unable to name a single source.
 *
 * `sample` is ranked alongside the CC0 registries (both rank 0) because it stands in
 * for registry-grade ground truth in offline mode; this is this package's own
 * reasonable extension of the architecture doc's `registry(CC0) > llm-web > paid`
 * rule (that rule doesn't explicitly place `sample`) — see README "Known
 * simplifications".
 */
import type { EnrichmentRecord } from "@mstack/core";

const SOURCE_RANK: Readonly<Record<string, number>> = {
  wikidata: 0,
  gleif: 0,
  edgar: 0,
  sample: 0,
  "llm-web": 1,
};
/** Anything not in SOURCE_RANK (opt-in paid vendors, or a future provider not yet
 *  registered here) is treated as last-resort trust. */
const UNKNOWN_SOURCE_RANK = 2;

function rankOf(source: string): number {
  return SOURCE_RANK[source] ?? UNKNOWN_SOURCE_RANK;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Merge N provider records into one, resolving every field by trust order. Records
 * are expected to already be for the same company (a router/caller's job to have
 * queried each provider for the same `ref` — this function does not check `domain`
 * equality across inputs). Returns null for an empty input.
 */
export function mergeEnrichment(records: EnrichmentRecord[]): EnrichmentRecord | null {
  if (records.length === 0) return null;

  // Stable sort by trust rank ascending (0 = most trusted); Array#sort is stable in
  // Node/V8, so equal-rank records keep their original relative order — that IS the
  // documented same-tier tie-break.
  const ranked = records
    .map((record, index) => ({ record, index, rank: rankOf(record.source) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.record);

  const first = ranked[0];
  if (!first) return null; // unreachable given the length check above; satisfies noUncheckedIndexedAccess

  const merged: EnrichmentRecord = {
    domain: first.domain,
    firmographic: { tech: [] },
    provenance: {},
    source: "merged",
  };

  const claim = (field: string, value: unknown, source: string, apply: () => void): void => {
    if (!isPresent(value)) return;
    if (merged.provenance[field] !== undefined) return; // a higher-trust record already won this field
    apply();
    merged.provenance[field] = source;
  };

  for (const record of ranked) {
    claim("name", record.name, record.source, () => {
      merged.name = record.name;
    });
    claim("employees", record.firmographic.employees, record.source, () => {
      merged.firmographic.employees = record.firmographic.employees;
    });
    claim("industry", record.firmographic.industry, record.source, () => {
      merged.firmographic.industry = record.firmographic.industry;
    });
    claim("region", record.firmographic.region, record.source, () => {
      merged.firmographic.region = record.firmographic.region;
    });
    claim("tech", record.firmographic.tech, record.source, () => {
      merged.firmographic.tech = record.firmographic.tech;
    });
    claim("contacts", record.contacts, record.source, () => {
      merged.contacts = record.contacts;
    });
  }

  return merged;
}
