/**
 * Schema-validity gate for every fixture under data/. Runs the ACTUAL core zod schemas
 * (not a hand-rolled shadow) against every row in every sample file, so a future edit to
 * a fixture (or a schema) that breaks the contract fails CI here instead of at demo time.
 *
 * `EnrichmentRecord` (accounts.sample.json's shape) is a plain TS interface in
 * packages/core/src/seams.ts, not its own zod schema — so accounts are validated by
 * running the real, exported zod pieces it's composed from (Firmographic, CommitteeMember,
 * Provenance) against each sub-field, plus plain runtime checks for the two fields that
 * have no schema of their own (domain, source).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  Signal,
  Guideline,
  GuidelineType,
  ClaimCategory,
  Firmographic,
  CommitteeMember,
  Provenance,
  ReviewRequest,
} from "@mstack/core";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ─────────────────────── data/signals.sample.jsonl ─────────────────────── */

describe("data/signals.sample.jsonl", () => {
  const rows = readJsonl(here("./signals.sample.jsonl")) as Array<{
    id: string;
    kind: string;
    actor: { company?: string };
  }>;

  it("has between 60 and 120 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.length).toBeLessThanOrEqual(120);
  });

  it("every row parses as a Signal", () => {
    for (const row of rows) Signal.parse(row);
  });

  it("spans all four demo signal kinds (product_usage, crm, campaign, intent)", () => {
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ["product_usage", "crm", "campaign", "intent"]) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it("covers the four named SignalSphere demo companies", () => {
    const companies = new Set(rows.map((r) => r.actor.company).filter(Boolean));
    for (const d of ["figma.com", "airtable.com", "stripe.com", "vercel.com"]) {
      expect(companies.has(d)).toBe(true);
    }
  });

  it("spans 8-12 distinct companies total", () => {
    const companies = new Set(rows.map((r) => r.actor.company).filter(Boolean));
    expect(companies.size).toBeGreaterThanOrEqual(8);
    expect(companies.size).toBeLessThanOrEqual(12);
  });

  it("has unique ids", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ─────────────────────── data/accounts.sample.json ─────────────────────── */

describe("data/accounts.sample.json", () => {
  const accounts = readJson(here("./accounts.sample.json")) as Array<{
    domain: string;
    name?: string;
    firmographic: unknown;
    contacts?: unknown[];
    provenance: unknown;
    source: string;
  }>;

  it("is an array of ~30 EnrichmentRecord fixtures", () => {
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThanOrEqual(25);
    expect(accounts.length).toBeLessThanOrEqual(35);
  });

  it("every row is shaped like the EnrichmentRecord seam (packages/core/src/seams.ts)", () => {
    for (const row of accounts) {
      expect(typeof row.domain).toBe("string");
      expect(row.domain.length).toBeGreaterThan(0);
      if (row.name !== undefined) expect(typeof row.name).toBe("string");
      Firmographic.parse(row.firmographic); // real core schema
      Provenance.parse(row.provenance); // real core schema (field -> source)
      expect(typeof row.source).toBe("string");
      if (row.contacts) {
        for (const c of row.contacts) CommitteeMember.parse(c); // real core schema
      }
    }
  });

  it("covers every company referenced by signals.sample.jsonl", () => {
    const signalRows = readJsonl(here("./signals.sample.jsonl")) as Array<{ actor: { company?: string } }>;
    const signalCompanies = new Set(signalRows.map((r) => r.actor.company).filter(Boolean));
    const acctDomains = new Set(accounts.map((a) => a.domain));
    for (const d of signalCompanies) expect(acctDomains.has(d)).toBe(true);
  });

  it("has unique domains", () => {
    const domains = accounts.map((a) => a.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("includes the demo's Figma buying committee (Aris Thorne, Linus Sterling)", () => {
    const figma = accounts.find((a) => a.domain === "figma.com");
    expect(figma).toBeDefined();
    const contacts = (figma?.contacts ?? []) as Array<{ name: string }>;
    const names = contacts.map((c) => c.name);
    expect(names).toContain("Aris Thorne");
    expect(names).toContain("Linus Sterling");
  });
});

/* ─────────────────────── data/corpus/guidelines.json ─────────────────────── */

describe("data/corpus/guidelines.json", () => {
  const guidelines = readJson(here("./corpus/guidelines.json")) as Array<{
    id: string;
    category: string;
    type: string;
    content: string;
  }>;

  it("every row parses as a Guideline", () => {
    for (const g of guidelines) Guideline.parse(g);
  });

  it("covers all five GuidelineType values", () => {
    const types = new Set(guidelines.map((g) => g.type));
    for (const t of GuidelineType.options) expect(types.has(t)).toBe(true);
  });

  it("covers all six ClaimCategory values", () => {
    const categories = new Set(guidelines.map((g) => g.category));
    for (const c of ClaimCategory.options) expect(categories.has(c)).toBe(true);
  });

  it("has a tier_map row encoding the Elite-only 'Powered by KLZ Orchestrate' badge rule", () => {
    const tierRows = guidelines.filter((g) => g.type === "tier_map");
    expect(tierRows.length).toBeGreaterThanOrEqual(1);
    expect(tierRows.some((g) => g.content.includes("Powered by KLZ Orchestrate"))).toBe(true);
  });

  it("has approved_messaging rows to retrieve against", () => {
    const msgRows = guidelines.filter((g) => g.type === "approved_messaging");
    expect(msgRows.length).toBeGreaterThanOrEqual(3);
  });
});

/* ─────────────────────── data/corpus/approved-messaging.md ─────────────────────── */

describe("data/corpus/approved-messaging.md", () => {
  it("exists and is substantial RAG-ingest prose", () => {
    const content = readFileSync(here("./corpus/approved-messaging.md"), "utf8");
    expect(content.length).toBeGreaterThan(1000);
    expect(content).toContain("KLZ Orchestrate");
  });
});

/* ─────────────────────── data/corpus/assets/assets.json ─────────────────────── */

describe("data/corpus/assets/assets.json", () => {
  const assets = readJson(here("./corpus/assets/assets.json")) as Array<{
    partnerId: string;
    partnerTier: string;
    content: string;
  }>;

  it("has 3-4 sample partner submissions, each a valid ReviewRequest", () => {
    expect(assets.length).toBeGreaterThanOrEqual(3);
    expect(assets.length).toBeLessThanOrEqual(4);
    for (const a of assets) ReviewRequest.parse(a);
  });

  it("plants all six ClaimCategory violations in the ABC Corp submission", () => {
    const abc = assets.find((a) => a.partnerId === "ABC Corp");
    expect(abc).toBeDefined();
    expect(abc?.partnerTier).toBe("Select"); // required for the badge plant to actually be a violation
    const c = abc?.content ?? "";
    expect(/\bguarantee(s|d)?\b/i.test(c)).toBe(true); // guaranteed_outcome
    expect(c).toContain("10x ROI"); // uncited_quantitative
    expect(/no other platform/i.test(c)).toBe(true); // unapproved_superlative
    expect(c).toContain("Morgan Hale"); // unapproved_spokesperson_quote (not on the allowlist)
    expect(c.includes("Agent Marketplace") && c.includes("Q4 2026")).toBe(true); // roadmap_disclosure
    expect(c).toContain("Powered by KLZ Orchestrate"); // badge_tier_misuse (Select using the Elite-only badge)
  });

  it("has at least one clean asset with none of the violation markers (should score APPROVED)", () => {
    const markers = [
      /\bguarantee(s|d)?\b/i,
      /no other (platform|partner)/i,
      /best-in-class/i,
      /Morgan Hale/i,
      /Agent Marketplace/i,
      /Powered by KLZ Orchestrate/,
      /KLZ Select Partner/,
    ];
    const clean = assets.filter((a) => markers.every((re) => !re.test(a.content)));
    expect(clean.length).toBeGreaterThanOrEqual(1);
    expect(clean.some((a) => a.partnerId === "Northland Analytics")).toBe(true);
  });
});
