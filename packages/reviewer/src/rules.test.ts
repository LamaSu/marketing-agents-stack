import { describe, it, expect, beforeAll } from "vitest";
import type { Guideline, ReviewRequest, ClaimCategory } from "@mstack/core";

import {
  scanDeterministic,
  runGitleaksIfAvailable,
  presidioScan,
  loadFullGuidelineCorpus,
  loadReviewRequests,
} from "./index.js";

describe("scanDeterministic — the mechanical pre-scan, run against the real sample corpus", () => {
  let guidelines: Guideline[];
  let assets: ReviewRequest[];

  beforeAll(async () => {
    guidelines = await loadFullGuidelineCorpus();
    assets = await loadReviewRequests();
  });

  function asset(partnerId: string): ReviewRequest {
    const found = assets.find((a) => a.partnerId === partnerId);
    if (!found) throw new Error(`fixture asset not found: ${partnerId}`);
    return found;
  }

  function categoriesFor(partnerId: string): Set<ClaimCategory> {
    const a = asset(partnerId);
    const findings = scanDeterministic({ content: a.content, partnerTier: a.partnerTier }, guidelines);
    return new Set(findings.map((f) => f.category));
  }

  /* ── the ABC Corp dirty asset: plants all six ClaimCategory violations ── */

  it("flags guarantee, superlative, spokesperson, roadmap, and badge_tier on ABC Corp (required categories)", () => {
    const categories = categoriesFor("ABC Corp");
    expect(categories.has("guaranteed_outcome")).toBe(true);
    expect(categories.has("unapproved_superlative")).toBe(true);
    expect(categories.has("unapproved_spokesperson_quote")).toBe(true);
    expect(categories.has("roadmap_disclosure")).toBe(true);
    expect(categories.has("badge_tier_misuse")).toBe(true);
  });

  it("also flags uncited_quantitative on ABC Corp (bonus best-effort category -- see rules.ts header)", () => {
    expect(categoriesFor("ABC Corp").has("uncited_quantitative")).toBe(true);
  });

  it("catches the specific ABC Corp violations by quoted text / recommendedChange", () => {
    const a = asset("ABC Corp");
    const findings = scanDeterministic({ content: a.content, partnerTier: a.partnerTier }, guidelines);

    const byCategory = (c: ClaimCategory) => findings.filter((f) => f.category === c);

    expect(byCategory("guaranteed_outcome").some((f) => /guarantee/i.test(f.quote))).toBe(true);
    expect(byCategory("uncited_quantitative").some((f) => f.quote.includes("10x"))).toBe(true);
    expect(byCategory("unapproved_superlative").some((f) => /no other platform/i.test(f.quote))).toBe(true);
    expect(byCategory("unapproved_spokesperson_quote").some((f) => f.recommendedChange.includes("Morgan Hale"))).toBe(true);
    expect(byCategory("roadmap_disclosure").some((f) => f.quote.includes("Agent Marketplace"))).toBe(true);
    expect(byCategory("roadmap_disclosure").some((f) => f.quote.includes("Q4 2026"))).toBe(true);
    expect(byCategory("badge_tier_misuse").some((f) => f.quote === "Powered by KLZ Orchestrate")).toBe(true);
  });

  it("every ABC Corp finding is well-formed: deterministic, unsupported (no retrieval done here), required iff not low severity", () => {
    const a = asset("ABC Corp");
    const findings = scanDeterministic({ content: a.content, partnerTier: a.partnerTier }, guidelines);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.detectedBy).toBe("deterministic");
      expect(f.supportingPassageId).toBeNull();
      expect(f.required).toBe(f.severity !== "low");
      expect(f.quote.length).toBeGreaterThan(0);
      expect(f.recommendedChange.length).toBeGreaterThan(0);
    }
  });

  /* ── the other three fixtures: precision checks (no false positives) ── */

  it("scores Northland Analytics (the clean, fully-cited asset) with zero findings", () => {
    const nl = asset("Northland Analytics");
    const findings = scanDeterministic({ content: nl.content, partnerTier: nl.partnerTier }, guidelines);
    expect(findings).toEqual([]);
  });

  it("flags Victorly for an uncited quantitative claim and badge/tier misuse, and nothing else", () => {
    const categories = categoriesFor("Victorly");
    expect(categories.has("uncited_quantitative")).toBe(true);
    expect(categories.has("badge_tier_misuse")).toBe(true);
    expect(categories.has("guaranteed_outcome")).toBe(false);
    expect(categories.has("unapproved_spokesperson_quote")).toBe(false);
    expect(categories.has("roadmap_disclosure")).toBe(false);
    expect(categories.size).toBe(2);
  });

  it("flags BrightPath for unapproved superlatives only (both 'best-in-class' and the 'no other partner...' comparative)", () => {
    const bp = asset("BrightPath");
    const findings = scanDeterministic({ content: bp.content, partnerTier: bp.partnerTier }, guidelines);
    const categories = new Set(findings.map((f) => f.category));
    expect(categories.size).toBe(1);
    expect(categories.has("unapproved_superlative")).toBe(true);
    expect(findings.some((f) => f.quote.toLowerCase().includes("best-in-class"))).toBe(true);
    expect(findings.some((f) => /no other partner/i.test(f.quote))).toBe(true);
  });

  /* ── regression: a lexicon term that does not start with a word character ── */

  it("catches the '#1' lexicon term even at the very start of a sentence (non-word-initial term regression)", () => {
    // termRegex() used to prepend an unconditional \b, which can never find a
    // boundary immediately before a non-word character like '#' -- "#1" would
    // silently never match. Covers gl-lex-superlative-1's literal '#1' term.
    const findings = scanDeterministic({ content: "#1 in the industry, hands down.", partnerTier: "Elite" }, guidelines);
    expect(findings.some((f) => f.category === "unapproved_superlative" && f.quote.startsWith("#1"))).toBe(true);
  });

  it("also catches '#1' mid-sentence, after a space", () => {
    const findings = scanDeterministic({ content: "Our platform is rated #1 by every customer survey.", partnerTier: "Elite" }, guidelines);
    expect(findings.some((f) => f.category === "unapproved_superlative" && f.quote.startsWith("#1"))).toBe(true);
  });

  /* ── citation-window precision: the same numeric shape, cited vs uncited ── */

  it("does NOT flag a cited percentage even though it matches the same numeric pattern as an uncited one", () => {
    // Northland's "22%" is cited ("published at northlandanalytics.com/reports/q1-2026");
    // Victorly's "40%" is not. Both match the identical \d+% pattern -- this is the
    // citation-window logic actually discriminating, not just "no percents present."
    const nl = asset("Northland Analytics");
    const nlFindings = scanDeterministic({ content: nl.content, partnerTier: nl.partnerTier }, guidelines);
    expect(nlFindings.some((f) => f.category === "uncited_quantitative")).toBe(false);

    const v = asset("Victorly");
    const vFindings = scanDeterministic({ content: v.content, partnerTier: v.partnerTier }, guidelines);
    expect(vFindings.some((f) => f.category === "uncited_quantitative" && f.quote.includes("40%"))).toBe(true);
  });

  /* ── inline secret pass: synthetic input, independent of the asset fixtures ── */

  it("flags a credential-shaped string via the always-on inline secret pass", () => {
    const findings = scanDeterministic(
      { content: 'Here is our staging config: aws_key = "AKIAABCDEFGHIJKLMNOP" -- do not share this.', partnerTier: "Elite" },
      guidelines,
    );
    const secretFindings = findings.filter((f) => f.recommendedChange.includes("credential-shaped"));
    expect(secretFindings.length).toBeGreaterThan(0);
    expect(secretFindings[0]?.severity).toBe("high");
    // Mapped onto roadmap_disclosure -- ClaimCategory has no dedicated secret-leak
    // value; see the "8. inline secret pass" section of rules.ts for why.
    expect(secretFindings[0]?.category).toBe("roadmap_disclosure");
  });

  it("does not flag ordinary prose with no credential-shaped substrings", () => {
    const findings = scanDeterministic({ content: "Just a normal sentence about our roadmap-free product update.", partnerTier: "Elite" }, guidelines);
    expect(findings.some((f) => f.recommendedChange.includes("credential-shaped"))).toBe(false);
  });

  /* ── the opt-in real-gitleaks backstop: must never throw, binary or not ── */

  it("runGitleaksIfAvailable never throws, whether or not the gitleaks binary is installed", async () => {
    const result = await runGitleaksIfAvailable(".");
    expect(Array.isArray(result)).toBe(true);
  });

  /* ── inline PII pass (Wave B2): synthetic input, independent of the asset fixtures ── */

  it("flags a planted email address and SSN via the always-on inline PII pass (category pii_leak)", () => {
    const findings = scanDeterministic(
      {
        content:
          "Reach our partnerships lead at jane.doe@acmepartner.com with any questions; " +
          "her SSN on file for the vendor form is 123-45-6789.",
        partnerTier: "Elite",
      },
      guidelines,
    );
    const piiFindings = findings.filter((f) => f.category === "pii_leak");
    expect(piiFindings.some((f) => f.quote === "jane.doe@acmepartner.com")).toBe(true);
    expect(piiFindings.some((f) => f.quote === "123-45-6789")).toBe(true);
    for (const f of piiFindings) {
      expect(f.detectedBy).toBe("deterministic");
      expect(f.required).toBe(true);
      expect(f.supportingPassageId).toBeNull();
    }
  });

  it("flags a planted phone number and credit card number via the same PII pass", () => {
    const findings = scanDeterministic(
      { content: "Call our team at 415-555-0199, or pay by card: 4111-1111-1111-1111.", partnerTier: "Elite" },
      guidelines,
    );
    const piiFindings = findings.filter((f) => f.category === "pii_leak");
    expect(piiFindings.some((f) => f.quote === "415-555-0199")).toBe(true);
    expect(piiFindings.some((f) => f.quote === "4111-1111-1111-1111")).toBe(true);
  });

  it("does not flag ordinary prose (percentages, quarters, plain numbers) as PII", () => {
    const findings = scanDeterministic(
      { content: "Teams reported a 22% reduction in Q1 2026, across 40 deployments and 3.2 review cycles.", partnerTier: "Elite" },
      guidelines,
    );
    expect(findings.some((f) => f.category === "pii_leak")).toBe(false);
  });

  it("the ABC Corp dirty asset (no PII planted) gets no pii_leak findings -- the PII scan adds nothing there, the original six categories are unaffected", () => {
    const categories = categoriesFor("ABC Corp");
    expect(categories.has("pii_leak")).toBe(false);
    // the original six required categories from the top of this file are still all present
    for (const c of [
      "guaranteed_outcome",
      "uncited_quantitative",
      "unapproved_superlative",
      "unapproved_spokesperson_quote",
      "roadmap_disclosure",
      "badge_tier_misuse",
    ] as ClaimCategory[]) {
      expect(categories.has(c)).toBe(true);
    }
  });

  it("none of the four real asset fixtures (ABC Corp, Northland, Victorly, BrightPath) trigger a false-positive PII finding", () => {
    for (const partnerId of ["ABC Corp", "Northland Analytics", "Victorly", "BrightPath"]) {
      expect(categoriesFor(partnerId).has("pii_leak")).toBe(false);
    }
  });

  /* ── the opt-in Presidio backstop (Wave B2): inert offline, parses when configured ── */

  it("presidioScan resolves to [] with no url/PRESIDIO_URL configured -- no network attempt, opt-in stays inert offline", async () => {
    const result = await presidioScan("contact jane@example.com for details");
    expect(result).toEqual([]);
  });

  it("presidioScan parses a canned Presidio /analyze response into pii_leak findings", async () => {
    const contentText = "contact jane@example.com for details";
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify([{ entity_type: "EMAIL_ADDRESS", start: 8, end: 24, score: 0.95 }]), { status: 200 });

    const result = await presidioScan(contentText, { url: "http://sidecar.local:5002", fetchImpl });

    expect(result.length).toBe(1);
    expect(result[0]?.category).toBe("pii_leak");
    expect(result[0]?.quote).toBe("jane@example.com");
    expect(result[0]?.detectedBy).toBe("deterministic");
  });

  it("presidioScan never throws on a non-OK or unreachable sidecar (opt-in, graceful degradation)", async () => {
    const failing: typeof fetch = async () => new Response("err", { status: 500 });
    await expect(presidioScan("x", { url: "http://sidecar.local:5002", fetchImpl: failing })).resolves.toEqual([]);

    const unreachable: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(presidioScan("x", { url: "http://sidecar.local:5002", fetchImpl: unreachable })).resolves.toEqual([]);
  });
});
