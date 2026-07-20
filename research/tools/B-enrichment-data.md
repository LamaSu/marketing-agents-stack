# B — Enrichment / Account & Contact Data Layer (Open Stack)

**Researcher:** researcher-bravo · **Date:** 2026-07-20 · **Status:** IN PROGRESS

The open alternative to Clay / ZoomInfo / Apollo / Persana — company & contact
enrichment, firmographics, tech-stack detection, buying-committee/people data —
for a Claude-native agents stack on our own TS workflow runtime. Must run
**offline with sample data** and **optionally** connect real sources, with
**gatecraft** brokering any API keys.

## Progress tracker
- [x] OpenCorporates (registry / firmographics)
- [x] Wappalyzer OSS alternatives (tech-stack detection)
- [x] Crunchbase free tier
- [x] Wikidata / Wikipedia
- [ ] Common Crawl
- [ ] Company website + LLM enrichment (scrape + Claude)
- [ ] GitHub / social signals
- [ ] Free email / domain tools (MX, DNS, catch-all, verification)
- [ ] OSS enrichment frameworks (e.g. theHarvester, Ballpoint/People, etc.)
- [ ] SEC EDGAR / GLEIF LEI (bonus registries)
- [ ] Synthesis: default v1 stack + adapter seam

---

## Adapter seam (the interface every provider implements)

All providers below are evaluated as implementations of ONE stable interface so
they are swappable behind a broker. Sketch:

```ts
interface EnrichmentProvider {
  id: string;                       // "opencorporates" | "wikidata" | "llm-web" | "sample"
  kind: "company" | "contact" | "tech" | "email";
  capabilities: Capability[];       // ["firmographics","tech_stack","people",...]
  enrichCompany?(input: CompanyRef): Promise<CompanyRecord>;   // domain|name|number
  enrichContact?(input: ContactRef): Promise<ContactRecord>;
  detectTech?(input: { url: string }): Promise<TechRecord>;
  verifyEmail?(input: { email: string }): Promise<EmailRecord>;
  // rate-limit + cost metadata for the router/broker
  limits: { rps?: number; monthly?: number; costPerCall?: number };
}
```

- **gatecraft** brokers the API key: providers never read `process.env` directly;
  the broker injects credentials at call time and logs the call (telemetry only).
- **Offline default:** a `sample` provider reads canned JSON fixtures so the whole
  stack runs with zero network/keys. Real providers are opt-in.
- **LLM-web provider:** a provider whose `enrichCompany` is "Claude does web
  research" — scrape the company site + open web, extract structured
  firmographics. This is the open replacement for a paid vendor call.

---

## 1. OpenCorporates — company registry / legal firmographics

**What it provides:** The largest open database of companies from official
government registries (~200M+ companies, 140+ jurisdictions): legal name,
company number, incorporation date, registered address, status, officers,
filings. Canonical for KYB / legal-entity firmographics.

**API:** REST, versioned (`api.opencorporates.com`, v0.4.x). JSON. Search by name
or fetch by jurisdiction+number.

**License / cost / limits:**
- **Free tier: 200 requests/month, 50/day, max 5 queries/sec** — but the free API
  is licensed for **open-data projects only**: your product/DB must be released
  under a **share-alike attribution** licence (attribution to OpenCorporates).
- Paid self-serve (removes share-alike): **Essentials £2,250/yr, Starter
  £6,600/yr, Basic £12,000/yr**; Enterprise = bulk, price-on-request.
- Overages billed as "surge charge".

**Adapter fit:** `opencorporates` provider, `kind:"company"`,
`capabilities:["legal_firmographics","officers","registry_id"]`. Key via
gatecraft. Router should treat it as **low-volume, high-trust** (registry ground
truth) — good for the 1-2 canonical companies in a workflow, NOT for enriching a
1000-row list on the free tier.

**Verdict: ADOPT (as an opt-in real provider).** The share-alike free tier is
actually *compatible* with an open stack. But rate limits make it a "verify the
key account" tool, not a bulk enricher. Keep behind the seam; default off.

Sources:
- https://opencorporates.com/pricing/
- https://api.opencorporates.com/documentation/API-Reference
- https://zephira.ai/opencorporates-pricing-explained-2026-plans-api-limits-licensing-and-what-it-means-in-production/

---

## 2. Wappalyzer OSS alternatives — tech-stack detection (BuiltWith alternative)

**What it provides:** Detect the technologies a company's website runs (CMS,
analytics, frameworks, ecommerce, CDNs, martech) — the "tech stack" signal Clay
and BuiltWith sell. Useful for ICP filtering ("companies using Shopify + Klaviyo").

**Wappalyzer itself is no longer open.** Acquired by **Hostinger in 2023**; the
fingerprint DB went **closed-source in May 2023**, the GitHub repo was archived,
and API pricing consolidated (~$450/mo Team plan). So Wappalyzer proper = SKIP.

**OSS forks that carry the fingerprints forward:**
- **`projectdiscovery/wappalyzergo`** (Go) — maintained OSS engine, community
  fingerprints, **7,300+ technologies**. Best-maintained. MIT-ish (ProjectDiscovery).
- **`s0md3v/wappalyzer-next`** (Python) — CLI + library, uses the extension
  fingerprints.
- CRFT Lookup — hosted fork of the formerly-OSS Wappalyzer.

**Adapter fit:** `techdetect` provider, `kind:"tech"`, `detectTech({url})`. Runs
**fully offline/local** (no API key, no vendor) — just fetch the target URL and
run the fingerprint engine on the HTML/headers/JS. This is a **pure-local
provider**, which is ideal for the open stack: no gatecraft key needed.

**Verdict: ADOPT — `wappalyzergo`** (Go) as the tech-stack provider, or
`wappalyzer-next` if we want to stay in Python. Self-hosted, free, no vendor.
This directly replaces a paid BuiltWith/Wappalyzer line item.

Sources:
- https://github.com/s0md3v/wappalyzer-next
- https://dev.to/nexgendata/wappalyzer-paywalled-itself-in-2023-heres-the-oss-powered-replacement-3i01
- https://detectzestack.com/wappalyzer-alternative (notes wappalyzergo, 7,300+ techs)

---

## 3. Crunchbase (free tier) — funding / startup firmographics

**What it provides:** Company profiles, funding rounds, investors, acquisitions,
headcount ranges, categories — the startup/VC firmographic layer.

**License / cost / limits:**
- **Free *API* access is gone** (as of 2025-2026). A free *account* lets you view
  basic profiles on the website only.
- Paid: **Basic $49/mo, Pro $99/mo** (7-day Pro trial). Real programmatic API =
  higher/enterprise tiers, contact sales.
- Data is proprietary/licensed — **not** redistributable in an open dataset.

**Adapter fit:** Could be an `crunchbase` provider `kind:"company"`
`capabilities:["funding","investors"]`, key via gatecraft. But the license
forbids building an open dataset from it, and there's no free API.

**Verdict: SKIP for v1 (leave a stub adapter).** No free API, proprietary
license, and **Wikidata + LLM-web research recover most of the funding/firmographic
signal for free**. Keep an empty `crunchbase` adapter shell so a user with a key
can drop it in, but do not depend on it.

Sources:
- https://dev.to/agenthustler/crunchbase-api-in-2026-free-tier-gone-what-startup-data-hunters-do-now-1177
- https://about.crunchbase.com/products/crunchbase-api
- https://support.crunchbase.com/hc/en-us/articles/360062989313

---

## 4. Wikidata / Wikipedia — free open firmographics knowledge graph

**What it provides:** Structured facts about companies: industry, HQ location,
founding date, founders, CEO, parent/subsidiary, stock ticker, employee count,
official website, logo, and **cross-IDs** (links to OpenCorporates, LEI, CRD,
SEC CIK, VAT, etc.). Wikipedia adds prose descriptions.

**API / access:**
- **SPARQL endpoint** (free, no auth): `https://query.wikidata.org/sparql`
  (`?query=...&format=json`). Also REST `wbgetentities`, and the Wikipedia REST
  summary API.
- **License: CC0** (public domain) for Wikidata — fully redistributable in an
  open stack. Wikipedia text is CC BY-SA.
- Limits: WDQS has a ~60s query timeout + fair-use throttling; set a descriptive
  `User-Agent`. No key.

**Adapter fit:** `wikidata` provider, `kind:"company"`,
`capabilities:["firmographics","cross_ids","description"]`. Given a company
domain or name, resolve the QID then pull the property bag. CC0 means results can
be cached into our own sample dataset. **This is the single best free structured
firmographic source** and pairs perfectly with the LLM-web provider (LLM handles
the long tail Wikidata doesn't cover).

**Verdict: ADOPT (primary free firmographic provider).** No key, CC0,
redistributable, rich cross-IDs to chain into OpenCorporates/LEI/SEC.

Sources:
- https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service
- https://query.wikidata.org/
- https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/queries/examples
