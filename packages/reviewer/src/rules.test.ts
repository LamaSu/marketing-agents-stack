import { describe, it, expect, beforeAll } from "vitest";
import type { Guideline, ReviewRequest, ClaimCategory } from "@mstack/core";

import { scanDeterministic, runGitleaksIfAvailable, loadFullGuidelineCorpus, loadReviewRequests } from "./index.js";

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
});
