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
- [x] Common Crawl
- [x] GLEIF LEI + SEC EDGAR (bonus registries)
- [x] Free email / domain tools (MX, DNS, catch-all, verification)
- [x] theHarvester (OSINT people/email framework)
- [x] LLM web-research enrichment (Crawl4AI/Firecrawl + Claude)
- [x] GitHub / social signals
- [ ] Paid-vendor seam examples (PDL / Hunter / Abstract free tiers)
- [ ] Synthesis: default v1 stack + adapter seam

---

## TL;DR — recommended v1 default

**Ship three providers behind one `EnrichmentProvider` seam:**

1. **`sample`** (offline default) — canned JSON fixtures; zero network/keys. The
   stack demos end-to-end with no credentials.
2. **`llm-web`** (the star) — **Crawl4AI** (OSS, self-hosted) fetches the company
   site + open web to clean markdown, then **Claude** extracts a typed
   firmographic/contact record against a JSON schema. This is the open
   replacement for a paid enrichment vendor.
3. **Free open registries, chained** — **Wikidata (CC0)** + **GLEIF LEI (CC0)** +
   **SEC EDGAR (public domain)** for structured ground-truth firmographics, and a
   **local `wappalyzergo`** tech-stack detector. All keyless or CC0, all
   redistributable, all safe to cache into the sample dataset.

**Paid vendors (OpenCorporates, Crunchbase, People Data Labs, Hunter, …) are
opt-in adapters behind the same seam, keys brokered by gatecraft, default off.**

---

## Adapter seam (the interface every provider implements)

All providers below are evaluated as implementations of ONE stable interface so
they are swappable behind a broker.

```ts
interface EnrichmentProvider {
  id: string;                       // "opencorporates" | "wikidata" | "llm-web" | "sample"
  kind: "company" | "contact" | "tech" | "email";
  capabilities: Capability[];       // ["firmographics","tech_stack","people",...]
  enrichCompany?(input: CompanyRef): Promise<CompanyRecord>;   // domain|name|number
  enrichContact?(input: ContactRef): Promise<ContactRecord>;
  detectTech?(input: { url: string }): Promise<TechRecord>;
  verifyEmail?(input: { email: string }): Promise<EmailRecord>;
  limits: { rps?: number; monthly?: number; costPerCall?: number };  // for router/broker
}
```

- **gatecraft** brokers the API key: providers never read `process.env` directly;
  the broker injects credentials at call time and logs the call (telemetry only).
- **Offline default:** the `sample` provider reads canned JSON fixtures so the
  whole stack runs with zero network/keys. Real providers are opt-in.
- **LLM-web provider:** a provider whose `enrichCompany` is "Claude does web
  research" — scrape the company site + open web, extract structured
  firmographics. The open replacement for a paid vendor call.
- **Router policy:** free/keyless/CC0 providers run first and cheapest; the
  `llm-web` provider fills gaps; paid vendors are last-resort and gated.

---

## 1. OpenCorporates — company registry / legal firmographics

**What:** Largest open DB of companies from official government registries
(~200M+ companies, 140+ jurisdictions): legal name, company number, incorporation
date, registered address, status, officers, filings. Canonical for KYB / legal
firmographics.

**API:** REST, versioned (`api.opencorporates.com`, v0.4.x), JSON. Search by name
or fetch by jurisdiction+number.

**License / cost / limits:**
- **Free tier: 200 req/month, 50/day, ≤5 q/s** — but free API is for **open-data
  projects only**: your product/DB must be released under **share-alike
  attribution** (attribution to OpenCorporates).
- Paid (removes share-alike): **Essentials £2,250/yr, Starter £6,600/yr, Basic
  £12,000/yr**; Enterprise = bulk, price-on-request. Overages = "surge charge".

**Adapter fit:** `opencorporates` / `kind:"company"` /
`["legal_firmographics","officers","registry_id"]`. Key via gatecraft.
Low-volume, high-trust (registry ground truth) — good for the 1-2 canonical
accounts in a workflow, NOT bulk-enriching a 1000-row list on the free tier.

**Verdict: ADOPT (opt-in real provider, default off).** The share-alike free
tier is actually *compatible* with an open stack, but rate limits make it a
"verify the key account" tool, not a bulk enricher.

Sources: https://opencorporates.com/pricing/ ·
https://api.opencorporates.com/documentation/API-Reference ·
https://zephira.ai/opencorporates-pricing-explained-2026-plans-api-limits-licensing-and-what-it-means-in-production/

---

## 2. Wappalyzer OSS alternatives — tech-stack detection (BuiltWith alternative)

**What:** Detect the technologies a company's site runs (CMS, analytics,
frameworks, ecommerce, CDNs, martech) — the tech-stack signal Clay/BuiltWith
sell. Enables ICP filtering ("companies using Shopify + Klaviyo").

**Wappalyzer itself is no longer open.** Acquired by **Hostinger, 2023**;
fingerprint DB went **closed-source May 2023**, GitHub repo archived, API ~$450/mo
Team plan. → Wappalyzer proper = SKIP.

**OSS forks carrying the fingerprints forward:**
- **`projectdiscovery/wappalyzergo`** (Go) — maintained OSS engine, community
  fingerprints, **7,300+ technologies**. Best-maintained; embeddable as a library.
- **`s0md3v/wappalyzer-next`** (Python) — CLI + library using extension fingerprints.
- CRFT Lookup — hosted fork of the formerly-OSS Wappalyzer.

**Adapter fit:** `techdetect` / `kind:"tech"` / `detectTech({url})`. Runs
**fully local** — fetch the target URL, run the fingerprint engine on
HTML/headers/JS. **No API key, no vendor** → ideal for the open stack. Directly
replaces a paid BuiltWith/Wappalyzer line item.

**Verdict: ADOPT — `wappalyzergo`** (or `wappalyzer-next` if staying in Python).

Sources: https://github.com/s0md3v/wappalyzer-next ·
https://dev.to/nexgendata/wappalyzer-paywalled-itself-in-2023-heres-the-oss-powered-replacement-3i01 ·
https://detectzestack.com/wappalyzer-alternative

---

## 3. Crunchbase (free tier) — funding / startup firmographics

**What:** Company profiles, funding rounds, investors, acquisitions, headcount
ranges, categories — the startup/VC firmographic layer.

**License / cost / limits:**
- **Free *API* access is gone** (2025-2026). A free *account* = view basic
  profiles on the website only.
- Paid: **Basic $49/mo, Pro $99/mo** (7-day Pro trial); real programmatic API =
  higher/enterprise, contact sales.
- Data is **proprietary/licensed — NOT redistributable** in an open dataset.

**Adapter fit:** Could be `crunchbase` / `kind:"company"` /
`["funding","investors"]`, key via gatecraft — but license forbids an open
dataset and there's no free API.

**Verdict: SKIP for v1 (leave a stub adapter).** No free API, proprietary
license. **Wikidata + SEC EDGAR + LLM-web research recover most of the
funding/firmographic signal for free.** Keep an empty `crunchbase` shell so a
key-holder can drop it in; don't depend on it.

Sources: https://dev.to/agenthustler/crunchbase-api-in-2026-free-tier-gone-what-startup-data-hunters-do-now-1177 ·
https://about.crunchbase.com/products/crunchbase-api ·
https://support.crunchbase.com/hc/en-us/articles/360062989313

---

## 4. Wikidata / Wikipedia — free open firmographics knowledge graph

**What:** Structured company facts: industry, HQ, founding date, founders, CEO,
parent/subsidiary, stock ticker, employee count, official website, logo, and
**cross-IDs** (OpenCorporates, LEI, SEC CIK, VAT, ISIN…). Wikipedia adds prose.

**API / access:**
- **SPARQL endpoint** (free, no auth): `https://query.wikidata.org/sparql`
  (`?query=...&format=json`); also REST `wbgetentities` + Wikipedia REST summary.
- **License: CC0** (public domain) — fully redistributable in an open stack
  (Wikipedia text is CC BY-SA).
- Limits: WDQS ~60s query timeout + fair-use throttling; set a descriptive
  `User-Agent`. No key.

**Adapter fit:** `wikidata` / `kind:"company"` /
`["firmographics","cross_ids","description"]`. Resolve domain/name → QID → pull
the property bag. CC0 means results can be cached into our sample dataset. Best
free structured firmographic source; pairs with `llm-web` for the long tail.

**Verdict: ADOPT (primary free firmographic provider).** Keyless, CC0,
redistributable, rich cross-IDs to chain into OpenCorporates/LEI/SEC.

Sources: https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service ·
https://query.wikidata.org/ ·
https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/queries/examples

---

## 5. Common Crawl — web-scale corpus / footprint discovery

**What:** Petabyte open web crawl (billions of pages, monthly). For enrichment:
discover a company's **web footprint** — which pages/subdomains exist for a
domain, historical snapshots, outbound links, mentions — without crawling live.

**API / access:**
- **CDX / CDXJ index** at `index.commoncrawl.org` (HTTP), or index files + WARC on
  the **AWS S3 public bucket**. Tools: **`cdx-toolkit`** (Python),
  `cdx-index-client`.
- **Cost: free.** All data/index on AWS Public Datasets, no key.

**Adapter fit:** Not a per-company real-time enricher — it's **bulk/offline**.
Best use: a batch job that builds our **offline sample dataset** (resolve domains
→ page inventories → feed the `llm-web` extractor), or footprint/subdomain
discovery. Heavy (WARC extraction); not in the hot path of a live workflow.

**Verdict: ADOPT for offline dataset-building; SKIP as a live provider.** Great
for seeding the `sample` provider's fixtures and for research batches; too heavy
to sit behind a synchronous `enrichCompany`.

Sources: https://index.commoncrawl.org/ · https://commoncrawl.org/cdxj-index ·
https://pypi.org/project/cdx-toolkit/

---

## 6. GLEIF LEI — legal-entity registry (CC0, free API)

**What:** Global Legal Entity Identifier index — standardized legal entity
reference data + **Level 2 "who owns whom"** ownership, plus mapped identifiers
(BIC, ISIN). Regulatory-grade entity resolution.

**API / access:**
- **GLEIF API** (production since 2020): full search, filters, full-text +
  single-field, **fuzzy name/address matching**. **No API key, free.**
- **License: CC0.** Fully open/redistributable. Bulk file download also offered.

**Adapter fit:** `gleif` / `kind:"company"` /
`["legal_entity","ownership","cross_ids"]`. Excellent **entity-resolution** step:
messy company name → canonical LEI + legal name + country + parent. Keyless + CC0
= same class as Wikidata. Chain: Wikidata QID → LEI → SEC CIK.

**Verdict: ADOPT (free entity-resolution + ownership provider).**

Sources: https://www.gleif.org/en/lei-data/gleif-api ·
https://www.gleif.org/en/about/open-data

---

## 7. SEC EDGAR — US public-company firmographics + financials (public domain)

**What:** Every US public-company filing. Three free services: **structured data
API** (`data.sec.gov` — company submissions + XBRL financial facts as JSON),
**full-text search** (`efts.sec.gov`, all filings since 2001 incl. exhibits), and
the **ticker→CIK map** (`company_tickers.json`).

**API / access:**
- **No auth, no key, free.** US-gov public domain data.
- Limits: **≤10 req/sec per IP, no daily cap**; **`User-Agent` header required**.
- Company Facts: `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`.

**Adapter fit:** `edgar` / `kind:"company"` /
`["financials","filings","officers","risk_factors"]`. For public targets: real
revenue/headcount/segments + verbatim risk factors (great LLM context for
account research). Chain: ticker → CIK → companyfacts.

**Verdict: ADOPT (free provider for public-company targets).** Only covers US
public companies, but for those it's ground-truth and free.

Sources: https://www.sec.gov/search-filings/edgar-application-programming-interfaces ·
https://dev.to/odeeb/the-sec-edgar-api-a-practical-guide-to-free-filing-data-in-python-15b

---

## 8. Free email / domain tools — MX / DNS / catch-all / verification

**What:** Validate/enrich work emails: syntax, domain existence, MX/DNS,
disposable-address detection, role-account (`info@`, `sales@`) detection,
free-provider detection, catch-all detection, and guess-a-pattern
(`{first}.{last}@domain`).

**OSS options:**
- **`AfterShip/email-verifier`** (Go, **MIT**) — SMTP verification with catch-all,
  DNS MX, disposable, role, free-provider, typo suggestions. No auth, no usage
  limits. **Best license + scope.**
- **Reacher** (Rust) — full stack (syntax→DNS→MX→SMTP→catch-all), fast, but
  **AGPL** (license friction for commercial embedding).
- **Truemail** (Ruby/Go), **Trumail** (Go — lib + API + Docker), Rapid Email
  Verifier — all OSS.

**Production caveat (important):** live **SMTP** mailbox probing is increasingly
unreliable (Gmail/Outlook don't reveal validity) and can **get your sending IP
blacklisted**. The **safe, free subset** = syntax + MX/DNS existence + disposable
+ role + free-provider + catch-all inference. Do that locally; skip live SMTP by
default. Pure DNS (MX/SPF/DMARC) needs no library at all.

**Adapter fit:** `email` / `kind:"email"` / `verifyEmail({email})`, plus a
`guessEmail(person, domain)` helper. Fully local, no key. gatecraft only needed
if a paid verifier (see §11) is swapped in.

**Verdict: ADOPT — `AfterShip/email-verifier` (MIT)** for the local email
provider; run the non-SMTP checks by default.

Sources: https://github.com/AfterShip/email-verifier ·
https://github.com/reacherhq/check-if-email-exists ·
https://www.usebouncer.com/open-source-email-verification/

---

## 9. theHarvester — OSINT people / email / subdomain framework

**What:** Given a domain/org, queries dozens of public sources (search engines,
certificate-transparency logs, DNS, PGP key servers, some social) and returns a
consolidated list of **emails, subdomains, hosts, IPs, and employee names**. The
closest OSS analogue to the "people / buying-committee" layer.

**License / cost:** OSS (`laramies/theHarvester`), free. Many high-value sources
(Shodan, some social) need **their own** API keys; the free sources still return
useful email/subdomain/CT data.

**Adapter fit:** `osint-people` / `kind:"contact"` — feed its output into
`enrichContact`. Caveat: it's a **pentest recon** tool; provenance is scraped
public data. For B2B marketing use, treat as *lead-discovery signal to verify*
(via §8), and honor robots/ToS + privacy law (GDPR/CCPA) on any people data.

**Verdict: ADOPT with care (opt-in `osint-people` provider).** Fills the
free-people-data gap that has no clean API equivalent, but gate it behind an
explicit opt-in and a compliance note; verify emails before use.

Sources: https://github.com/laramies/theHarvester ·
https://sherlockeye.io/blog/theharvester-osint-tool

---

## 10. LLM web-research enrichment (Crawl4AI / Firecrawl + Claude) — the star

**What:** The open replacement for a paid enrichment vendor. Pipeline: **crawl
the company site + open web → clean markdown → Claude extracts a typed record
against a JSON schema** (industry, size band, revenue signals, ICP fit, products,
recent news, buying signals, likely buying-committee roles).

**Tooling:**
- **Crawl4AI** (`unclecode/crawl4ai`, **OSS, Apache-2.0, ~68k stars**) —
  **local-first**, clean markdown, no external API required, plug local (Ollama)
  or hosted LLMs, chunking + similarity for targeted extraction, Dockerable.
  **Free, self-hosted — the right fit for an open stack.**
- **Firecrawl** (`firecrawl/firecrawl`) — managed API with schema-driven
  extraction + an **MCP server** for Claude; OSS repo exists but the smooth path
  is the paid API. Good as an **opt-in** high-quality crawler behind the seam.
- Claude does the extraction (structured output / tool-schema) — no data vendor
  in the loop; only crawler infra + LLM tokens.

**Adapter fit:** `llm-web` / `kind:"company"|"contact"` — the **gap-filler and
default enricher**. Where Wikidata/EDGAR/GLEIF have no row (private co., long
tail), `llm-web` researches it live. This is the concrete place **an LLM doing
web research replaces a paid vendor** (Clay/Apollo/Persana "AI research columns").

**Verdict: ADOPT — Crawl4AI + Claude as the primary `llm-web` provider;**
Firecrawl as an optional higher-quality crawler behind the same seam.

Sources: https://github.com/unclecode/crawl4ai ·
https://www.firecrawl.dev/blog/best-open-source-web-crawler ·
https://www.firecrawl.dev/blog/claude-code-skill

---

## 11. GitHub / social signals — developer & buying-signal enrichment

**What:** For dev-tool / infra ICPs, GitHub is a strong free signal: org repos,
languages/tech adoption, stars/forks/PR/issue activity, hiring signals, and
public member profiles. "Company uses/depends-on X" and "team is active in Y".

**API / access:**
- REST + GraphQL. **5,000 req/hr authenticated** (token), **60/hr unauth**;
  GitHub-App/Enterprise up to 15,000/hr. Free with a personal token.
- Caveat: returns a **username, not an email/company** — you must link identity
  (email domain in profile, org membership) to attach it to an account.

**Adapter fit:** `github-signals` / `kind:"company"` /
`["tech_adoption","dev_activity","buying_signal"]`, token via gatecraft. Optional,
ICP-specific (best for devtool/infra GTM).

**Verdict: ADOPT (opt-in, ICP-gated).** High-value for developer-tool marketing,
low-value otherwise. Keep behind the seam, default off unless ICP = developers.

Sources: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api ·
https://leadcognition.io/blog/github-activity-buying-signal/
