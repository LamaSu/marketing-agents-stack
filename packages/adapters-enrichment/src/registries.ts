/**
 * Keyless CC0/public-domain registry providers — Wikidata (SPARQL), GLEIF LEI
 * (api.gleif.org), SEC EDGAR (data.sec.gov). Each returns a PARTIAL EnrichmentRecord
 * (whatever fields that registry actually has) with per-field provenance set to its
 * own provider name, per research/tools/B-enrichment-data.md §4/§6/§7 and the merge
 * trust order (registry CC0 > llm-web > paid) in research/06-architecture.md §3.2.
 *
 * Grouped in one file (rather than one file each, unlike e.g. packages/credentials'
 * split) because all three share the same fetch→parse→partial-record shape and the
 * `fetchJson` helper below — splitting them would mostly duplicate that boilerplate
 * across three files for three genuinely small classes.
 *
 * All three take an injectable `fetchImpl` (defaults to `globalThis.fetch`) so tests
 * stay offline — inject a fake that returns canned JSON instead of hitting the network.
 *
 * ASSUMPTIONS ABOUT LIVE RESPONSE SHAPES (written from each service's public API docs,
 * NOT verified against a live call in this offline build session — no local
 * `pnpm install` per docs/build-conventions.md; verify on the first live Spark run):
 *  - Wikidata: SPARQL 1.1 JSON results format (`results.bindings[].<var>.value`) — a
 *    stable W3C spec, low risk.
 *  - GLEIF: `/api/v1/lei-records` JSON:API shape
 *    (`data[].attributes.entity.{legalName,legalAddress}`) per gleif.org/en/lei-data/gleif-api.
 *  - SEC EDGAR: `data.sec.gov/submissions/CIK##########.json` top-level
 *    `{name, sicDescription, addresses.business.stateOrCountry}` — chosen over the
 *    XBRL `companyfacts` endpoint because its shape maps directly onto
 *    `Firmographic{industry,region}`; `companyfacts` carries richer financials but
 *    needs per-concept XBRL tag parsing, left for a follow-up wave. CIK lookup goes
 *    through the public `company_tickers.json` ticker file, matched by a best-effort
 *    legal-name guess (see `guessNameFromDomain`) since neither EDGAR nor GLEIF index
 *    by domain.
 * Every parse below is defensive (optional chaining + try/catch around fetch+JSON) so
 * an unexpected live response shape degrades to `null`/omitted fields rather than
 * throwing.
 */
import type { EnrichmentProvider, EnrichmentRecord } from "@mstack/core";

export interface RegistryProviderConfig {
  /** injectable fetch — defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** all three registries ask for (SEC requires) a descriptive User-Agent with contact info. */
  userAgent?: string;
}

const DEFAULT_USER_AGENT = "marketing-agents-stack/0.1 (open-source; see repo for contact)";

async function fetchJson(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function emptyRecord(domain: string, source: string): EnrichmentRecord {
  return { domain, firmographic: { tech: [] }, provenance: {}, source };
}

/** Best-effort name guess from a bare domain, e.g. "stripe.com" -> "stripe",
 *  "meridian-stack.io" -> "meridian stack". Used only when `ref.name` is absent and
 *  the registry needs a name to search on (GLEIF, EDGAR — neither indexes by domain). */
function guessNameFromDomain(domain: string): string {
  const label = domain.trim().toLowerCase().replace(/^www\./, "").split(".")[0] ?? domain;
  return label.replace(/[-_]/g, " ");
}

/* ───────────────────────────── Wikidata ────────────────────────────── */

interface WikidataBindingValue {
  value?: string;
}
interface WikidataSparqlResponse {
  results?: {
    bindings?: Array<{
      itemLabel?: WikidataBindingValue;
      industryLabel?: WikidataBindingValue;
      countryLabel?: WikidataBindingValue;
      employees?: WikidataBindingValue;
    }>;
  };
}

/** Firmographics via Wikidata's SPARQL endpoint (CC0, keyless) — resolves a company by
 *  its "official website" property (P856) containing the given domain. */
export class WikidataProvider implements EnrichmentProvider {
  readonly name = "wikidata";
  readonly #fetchImpl: typeof fetch;
  readonly #userAgent: string;

  constructor(config: RegistryProviderConfig = {}) {
    this.#fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  }

  async enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null> {
    const domain = ref.domain.trim().toLowerCase();
    const safeDomain = domain.replace(/"/g, "");
    const query = [
      "SELECT ?itemLabel ?industryLabel ?countryLabel ?employees WHERE {",
      "  ?item wdt:P856 ?website .",
      `  FILTER(CONTAINS(LCASE(STR(?website)), "${safeDomain}"))`,
      "  OPTIONAL { ?item wdt:P452 ?industry. }",
      "  OPTIONAL { ?item wdt:P17 ?country. }",
      "  OPTIONAL { ?item wdt:P1128 ?employees. }",
      '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }',
      "} LIMIT 1",
    ].join("\n");
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;

    const json = (await fetchJson(this.#fetchImpl, url, this.#userAgent)) as WikidataSparqlResponse | null;
    const binding = json?.results?.bindings?.[0];
    if (!binding) return null;

    const name = binding.itemLabel?.value;
    const industry = binding.industryLabel?.value;
    const region = binding.countryLabel?.value;
    const employeesRaw = binding.employees?.value;
    const employees = employeesRaw !== undefined ? Number.parseInt(employeesRaw, 10) : undefined;

    const record = emptyRecord(domain, this.name);
    if (name) {
      record.name = name;
      record.provenance.name = this.name;
    }
    if (industry) {
      record.firmographic.industry = industry;
      record.provenance.industry = this.name;
    }
    if (region) {
      record.firmographic.region = region;
      record.provenance.region = this.name;
    }
    if (employees !== undefined && !Number.isNaN(employees)) {
      record.firmographic.employees = employees;
      record.provenance.employees = this.name;
    }
    return record;
  }
}

/* ────────────────────────────── GLEIF ──────────────────────────────── */

interface GleifLeiRecordsResponse {
  data?: Array<{
    attributes?: {
      entity?: {
        legalName?: { name?: string };
        legalAddress?: { country?: string };
      };
    };
  }>;
}

/** Legal-entity resolution via the GLEIF LEI API (CC0, keyless). GLEIF indexes by
 *  legal name, not domain — see `guessNameFromDomain` when `ref.name` is absent. */
export class GleifProvider implements EnrichmentProvider {
  readonly name = "gleif";
  readonly #fetchImpl: typeof fetch;
  readonly #userAgent: string;

  constructor(config: RegistryProviderConfig = {}) {
    this.#fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  }

  async enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null> {
    const domain = ref.domain.trim().toLowerCase();
    const nameGuess = ref.name ?? guessNameFromDomain(domain);
    const params = new URLSearchParams();
    params.set("filter[entity.legalName]", nameGuess);
    params.set("page[size]", "1");
    const url = `https://api.gleif.org/api/v1/lei-records?${params.toString()}`;

    const json = (await fetchJson(this.#fetchImpl, url, this.#userAgent)) as GleifLeiRecordsResponse | null;
    const entity = json?.data?.[0]?.attributes?.entity;
    if (!entity) return null;

    const record = emptyRecord(domain, this.name);
    const legalName = entity.legalName?.name;
    const country = entity.legalAddress?.country;
    if (legalName) {
      record.name = legalName;
      record.provenance.name = this.name;
    }
    if (country) {
      record.firmographic.region = country;
      record.provenance.region = this.name;
    }
    return record;
  }
}

/* ──────────────────────────── SEC EDGAR ────────────────────────────── */

interface EdgarTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}
type EdgarTickerFile = Record<string, EdgarTickerEntry>;

interface EdgarSubmissions {
  name?: string;
  sicDescription?: string;
  addresses?: {
    business?: { stateOrCountry?: string };
  };
}

/** Public-company firmographics via SEC EDGAR (public domain, keyless). Only covers US
 *  public companies — see the file-header assumptions and README for the CIK-lookup
 *  heuristic. */
export class EdgarProvider implements EnrichmentProvider {
  readonly name = "edgar";
  readonly #fetchImpl: typeof fetch;
  readonly #userAgent: string;

  constructor(config: RegistryProviderConfig = {}) {
    this.#fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  }

  async enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null> {
    const domain = ref.domain.trim().toLowerCase();
    const cik = await this.#lookupCik(ref, domain);
    if (!cik) return null;

    const padded = cik.padStart(10, "0");
    const json = (await fetchJson(
      this.#fetchImpl,
      `https://data.sec.gov/submissions/CIK${padded}.json`,
      this.#userAgent,
    )) as EdgarSubmissions | null;
    if (!json) return null;

    const record = emptyRecord(domain, this.name);
    if (json.name) {
      record.name = json.name;
      record.provenance.name = this.name;
    }
    if (json.sicDescription) {
      record.firmographic.industry = json.sicDescription;
      record.provenance.industry = this.name;
    }
    const state = json.addresses?.business?.stateOrCountry;
    if (state) {
      record.firmographic.region = state;
      record.provenance.region = this.name;
    }
    return record;
  }

  async #lookupCik(ref: { domain: string; name?: string }, domain: string): Promise<string | null> {
    const nameGuess = (ref.name ?? guessNameFromDomain(domain)).toLowerCase().trim();
    if (nameGuess.length < 3) return null; // too weak a signal to search reliably -- avoid a wasted call + junk matches

    const json = (await fetchJson(
      this.#fetchImpl,
      "https://www.sec.gov/files/company_tickers.json",
      this.#userAgent,
    )) as EdgarTickerFile | null;
    if (!json) return null;

    const entry = Object.values(json).find((candidate) => {
      const title = candidate.title?.toLowerCase() ?? "";
      return title.length > 0 && (title.includes(nameGuess) || nameGuess.includes(title));
    });
    return entry ? String(entry.cik_str) : null;
  }
}
