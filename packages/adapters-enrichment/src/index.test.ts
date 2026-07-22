import { describe, it, expect } from "vitest";
import type { EnrichmentRecord } from "@mstack/core";
import {
  SampleProvider,
  mergeEnrichment,
  enrichmentProvider,
  checkEmail,
  guessEmail,
  detectTech,
  WikidataProvider,
  GleifProvider,
  EdgarProvider,
  LlmWebProvider,
  crawl4aiFetchSite,
  createCrawl4aiFetchSite,
  type ResolveMx,
  type FetchSite,
  type ClaudeMessagesClient,
  type ClaudeMessageResult,
} from "./index.js";

/* ─────────────────────────── SampleProvider ─────────────────────────── */

describe("SampleProvider", () => {
  it("returns a full record offline for a domain in the real data/accounts.sample.json fixtures", async () => {
    const provider = new SampleProvider(); // default path -- reads the real repo fixture, zero network
    const record = await provider.enrich({ domain: "figma.com" });
    expect(record).not.toBeNull();
    expect(record?.source).toBe("sample");
    expect(record?.name).toBe("Figma");
    expect(record?.firmographic.employees).toBe(1500);
    expect(record?.firmographic.tech).toContain("react");
    expect(record?.provenance.employees).toBe("sample");
    const contactNames = (record?.contacts ?? []).map((c) => c.name);
    expect(contactNames).toContain("Aris Thorne");
  });

  it("is case-insensitive and trims the domain", async () => {
    const provider = new SampleProvider();
    const record = await provider.enrich({ domain: "  Figma.COM  " });
    expect(record?.domain).toBe("figma.com");
  });

  it("returns null for a domain with no fixture row", async () => {
    const provider = new SampleProvider();
    const record = await provider.enrich({ domain: "definitely-not-a-real-fixture-domain.zzz" });
    expect(record).toBeNull();
  });

  it("uses an injected `fixtures` array with zero filesystem access when supplied (offline seam demonstrated)", async () => {
    const fixtures: EnrichmentRecord[] = [
      {
        domain: "injected.example",
        name: "Injected Co",
        firmographic: { employees: 10, industry: "Testing", region: "US", tech: ["ts"] },
        provenance: { employees: "sample", industry: "sample", region: "sample", tech: "sample" },
        source: "sample",
      },
    ];
    const provider = new SampleProvider({ fixtures });
    const record = await provider.enrich({ domain: "injected.example" });
    expect(record?.name).toBe("Injected Co");
    const missing = await provider.enrich({ domain: "figma.com" }); // NOT in the injected fixtures
    expect(missing).toBeNull();
  });
});

/* ─────────────────────────── mergeEnrichment ─────────────────────────── */

describe("mergeEnrichment", () => {
  const wikidataRecord: EnrichmentRecord = {
    domain: "example.com",
    name: "Example Corp",
    firmographic: { employees: 500, industry: "Software", region: "US", tech: [] },
    provenance: { employees: "wikidata", industry: "wikidata", region: "wikidata" },
    source: "wikidata",
  };
  const llmWebRecord: EnrichmentRecord = {
    domain: "example.com",
    name: "Example Corp Inc.",
    firmographic: { employees: 9999, industry: "SaaS", region: "United States", tech: ["react", "node"] },
    provenance: { employees: "llm-web", industry: "llm-web", region: "llm-web", tech: "llm-web" },
    source: "llm-web",
  };

  it("resolves a conflicting field by trust order (registry beats llm-web) and keeps correct provenance", () => {
    const merged = mergeEnrichment([llmWebRecord, wikidataRecord]); // deliberately out of trust order in the input
    expect(merged).not.toBeNull();
    expect(merged?.firmographic.employees).toBe(500); // wikidata wins, NOT averaged
    expect(merged?.provenance.employees).toBe("wikidata");
    expect(merged?.firmographic.industry).toBe("Software");
    expect(merged?.provenance.industry).toBe("wikidata");
    expect(merged?.name).toBe("Example Corp");
    expect(merged?.provenance.name).toBe("wikidata");
  });

  it("is not averaging -- the winning value is exact, not a blend", () => {
    const merged = mergeEnrichment([llmWebRecord, wikidataRecord]);
    expect(merged?.firmographic.employees).not.toBe((500 + 9999) / 2);
  });

  it("falls through to a lower-trust source for a field only that source has", () => {
    const merged = mergeEnrichment([wikidataRecord, llmWebRecord]);
    // wikidataRecord.firmographic.tech is [] (empty -- not "present"); llm-web has the only real tech list.
    expect(merged?.firmographic.tech).toEqual(["react", "node"]);
    expect(merged?.provenance.tech).toBe("llm-web");
  });

  it("returns null for an empty input", () => {
    expect(mergeEnrichment([])).toBeNull();
  });

  it("ties within the same trust tier resolve by input order (first wins)", () => {
    const gleif: EnrichmentRecord = {
      domain: "example.com",
      firmographic: { region: "USA", tech: [] },
      provenance: { region: "gleif" },
      source: "gleif",
    };
    const edgar: EnrichmentRecord = {
      domain: "example.com",
      firmographic: { region: "US", tech: [] },
      provenance: { region: "edgar" },
      source: "edgar",
    };
    const merged = mergeEnrichment([gleif, edgar]); // both rank 0 (registry tier)
    expect(merged?.firmographic.region).toBe("USA");
    expect(merged?.provenance.region).toBe("gleif");
  });
});

/* ─────────────────────────── factory ─────────────────────────── */

describe("enrichmentProvider factory", () => {
  it("defaults to SampleProvider with zero args", () => {
    const provider = enrichmentProvider();
    expect(provider).toBeInstanceOf(SampleProvider);
    expect(provider.name).toBe("sample");
  });

  it('enrichmentProvider("sample") is explicit-equivalent to the default', () => {
    expect(enrichmentProvider("sample").name).toBe("sample");
  });

  it('enrichmentProvider("llm-web") throws without a client -- no offline default', () => {
    expect(() => enrichmentProvider("llm-web")).toThrow(/client/i);
  });

  it('enrichmentProvider("llm-web", {client}) constructs an LlmWebProvider', () => {
    const fakeClient: ClaudeMessagesClient = {
      messages: { create: async () => ({ content: [] }) satisfies ClaudeMessageResult },
    };
    const provider = enrichmentProvider("llm-web", { client: fakeClient });
    expect(provider).toBeInstanceOf(LlmWebProvider);
    expect(provider.name).toBe("llm-web");
  });

  it('enrichmentProvider("wikidata"|"gleif"|"edgar") construct the registry providers', () => {
    expect(enrichmentProvider("wikidata")).toBeInstanceOf(WikidataProvider);
    expect(enrichmentProvider("gleif")).toBeInstanceOf(GleifProvider);
    expect(enrichmentProvider("edgar")).toBeInstanceOf(EdgarProvider);
  });
});

/* ─────────────────────────── email ─────────────────────────── */

describe("checkEmail / guessEmail", () => {
  it("flags invalid syntax without attempting an MX lookup", async () => {
    let called = false;
    const resolveMx: ResolveMx = async () => {
      called = true;
      return [];
    };
    const result = await checkEmail("not-an-email", { resolveMx });
    expect(result.syntaxValid).toBe(false);
    expect(result.hasMx).toBeNull();
    expect(result.domain).toBeNull();
    expect(called).toBe(false);
  });

  it("resolves MX via an injected resolver (offline)", async () => {
    const calls: string[] = [];
    const resolveMx: ResolveMx = async (domain) => {
      calls.push(domain);
      return [{ exchange: "mx.example.com", priority: 10 }];
    };
    const result = await checkEmail("person@example.com", { resolveMx });
    expect(result.syntaxValid).toBe(true);
    expect(result.hasMx).toBe(true);
    expect(calls).toEqual(["example.com"]);
  });

  it("treats a DNS failure as hasMx:false, not a thrown error", async () => {
    const resolveMx: ResolveMx = async () => {
      throw new Error("ENOTFOUND");
    };
    const result = await checkEmail("person@no-such-domain.invalid", { resolveMx });
    expect(result.hasMx).toBe(false);
  });

  it("skipMx leaves hasMx null without calling the resolver", async () => {
    let called = false;
    const resolveMx: ResolveMx = async () => {
      called = true;
      return [];
    };
    const result = await checkEmail("person@example.com", { skipMx: true, resolveMx });
    expect(result.hasMx).toBeNull();
    expect(called).toBe(false);
  });

  it("detects role accounts and free providers", async () => {
    const role = await checkEmail("info@example.com", { skipMx: true });
    expect(role.isRoleAccount).toBe(true);
    const free = await checkEmail("someone@gmail.com", { skipMx: true });
    expect(free.isFreeProvider).toBe(true);
    const normal = await checkEmail("aris.thorne@figma.com", { skipMx: true });
    expect(normal.isRoleAccount).toBe(false);
    expect(normal.isFreeProvider).toBe(false);
  });

  it("guessEmail builds the {first}.{last}@domain pattern", () => {
    expect(guessEmail({ firstName: "Aris", lastName: "Thorne" }, "figma.com")).toBe("aris.thorne@figma.com");
  });
});

/* ─────────────────────────── techdetect ─────────────────────────── */

describe("detectTech", () => {
  it("is an honest stub -- always returns an empty tech list with a note, never a fabricated guess", async () => {
    const result = await detectTech("https://figma.com");
    expect(result.tech).toEqual([]);
    expect(result.note.length).toBeGreaterThan(0);
    expect(result.url).toBe("https://figma.com");
  });
});

/* ─────────────────────────── registries ─────────────────────────── */

describe("WikidataProvider", () => {
  it("parses a canned SPARQL JSON response into a partial record with provenance", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                itemLabel: { value: "Example Corp" },
                industryLabel: { value: "Software" },
                countryLabel: { value: "United States of America" },
                employees: { value: "500" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    const provider = new WikidataProvider({ fetchImpl });
    const record = await provider.enrich({ domain: "example.com" });
    expect(record?.source).toBe("wikidata");
    expect(record?.name).toBe("Example Corp");
    expect(record?.firmographic.industry).toBe("Software");
    expect(record?.firmographic.employees).toBe(500);
    expect(record?.provenance.employees).toBe("wikidata");
  });

  it("returns null on an empty bindings array", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 });
    const provider = new WikidataProvider({ fetchImpl });
    expect(await provider.enrich({ domain: "no-such-company.example" })).toBeNull();
  });

  it("returns null gracefully on a non-OK response (never throws)", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 500 });
    const provider = new WikidataProvider({ fetchImpl });
    await expect(provider.enrich({ domain: "example.com" })).resolves.toBeNull();
  });
});

describe("GleifProvider", () => {
  it("parses a canned LEI-records JSON:API response into a partial record", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              attributes: {
                entity: { legalName: { name: "Example Corp Ltd" }, legalAddress: { country: "US" } },
              },
            },
          ],
        }),
        { status: 200 },
      );
    const provider = new GleifProvider({ fetchImpl });
    const record = await provider.enrich({ domain: "example.com", name: "Example Corp" });
    expect(record?.source).toBe("gleif");
    expect(record?.name).toBe("Example Corp Ltd");
    expect(record?.firmographic.region).toBe("US");
    expect(record?.provenance.region).toBe("gleif");
  });

  it("returns null when no LEI record matches", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const provider = new GleifProvider({ fetchImpl });
    expect(await provider.enrich({ domain: "example.com" })).toBeNull();
  });
});

describe("EdgarProvider", () => {
  it("looks up a CIK from the ticker file, then parses the submissions response", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("company_tickers.json")) {
        return new Response(
          JSON.stringify({ "0": { cik_str: 320193, ticker: "EXCO", title: "Example Corp" } }),
          { status: 200 },
        );
      }
      if (url.includes("/submissions/")) {
        return new Response(
          JSON.stringify({
            name: "Example Corp",
            sicDescription: "Prepackaged Software",
            addresses: { business: { stateOrCountry: "CA" } },
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };
    const provider = new EdgarProvider({ fetchImpl });
    const record = await provider.enrich({ domain: "example.com", name: "Example Corp" });
    expect(record?.source).toBe("edgar");
    expect(record?.name).toBe("Example Corp");
    expect(record?.firmographic.industry).toBe("Prepackaged Software");
    expect(record?.firmographic.region).toBe("CA");
  });

  it("returns null when no ticker entry matches", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ "0": { cik_str: 1, ticker: "ZZZ", title: "Totally Unrelated Inc" } }),
        { status: 200 },
      );
    const provider = new EdgarProvider({ fetchImpl });
    expect(await provider.enrich({ domain: "example.com", name: "Nonmatching Company Name" })).toBeNull();
  });

  it("returns null for a too-short name guess without even calling fetch", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const provider = new EdgarProvider({ fetchImpl });
    expect(await provider.enrich({ domain: "ab.io" })).toBeNull(); // domain label "ab" -> nameGuess length 2
    expect(called).toBe(false);
  });
});

/* ─────────────────────────── LlmWebProvider ─────────────────────────── */

describe("LlmWebProvider", () => {
  function fakeClientReturning(input: unknown): ClaudeMessagesClient {
    return {
      messages: {
        create: async () =>
          ({ content: [{ type: "tool_use", name: "emit_enrichment_record", input }] }) satisfies ClaudeMessageResult,
      },
    };
  }

  it("extracts a valid EnrichmentRecord from a canned fetchSite + canned Claude tool-use response", async () => {
    const client = fakeClientReturning({
      name: "Example Corp",
      employees: 250,
      industry: "Developer Tools",
      region: "US",
      tech: ["typescript", "react"],
    });
    const fetchCalls: string[] = [];
    const fetchSite: FetchSite = async (url) => {
      fetchCalls.push(url);
      return "Example Corp builds developer tools for TypeScript teams.";
    };
    const provider = new LlmWebProvider({ client, fetchSite });

    const record = await provider.enrich({ domain: "example.com" });
    expect(record?.source).toBe("llm-web");
    expect(record?.name).toBe("Example Corp");
    expect(record?.firmographic.employees).toBe(250);
    expect(record?.firmographic.tech).toEqual(["typescript", "react"]);
    expect(record?.provenance.industry).toBe("llm-web");
    expect(fetchCalls).toEqual(["https://example.com"]);
  });

  it("returns null when fetchSite throws (unreachable site)", async () => {
    const client = fakeClientReturning({ name: null, employees: null, industry: null, region: null, tech: [] });
    const fetchSite: FetchSite = async () => {
      throw new Error("ENOTFOUND");
    };
    const provider = new LlmWebProvider({ client, fetchSite });
    expect(await provider.enrich({ domain: "unreachable.example" })).toBeNull();
  });

  it("returns null when Claude returns no tool-use block", async () => {
    const client: ClaudeMessagesClient = {
      messages: {
        create: async () => ({ content: [{ type: "text", text: "I decline." }] }) satisfies ClaudeMessageResult,
      },
    };
    const fetchSite: FetchSite = async () => "some site text";
    const provider = new LlmWebProvider({ client, fetchSite });
    expect(await provider.enrich({ domain: "example.com" })).toBeNull();
  });

  it("returns null when the tool-use input fails zod validation (malformed extraction)", async () => {
    const client = fakeClientReturning({
      name: 12345 /* wrong type -- should be string|null */,
      employees: null,
      industry: null,
      region: null,
      tech: [],
    });
    const fetchSite: FetchSite = async () => "some site text";
    const provider = new LlmWebProvider({ client, fetchSite });
    expect(await provider.enrich({ domain: "example.com" })).toBeNull();
  });
});

/* ─────────────────────────── crawl4aiFetchSite ─────────────────────────── */

describe("crawl4aiFetchSite / createCrawl4aiFetchSite", () => {
  /** Builds a canned `POST /crawl` response body for a single-URL request. */
  function crawl4aiResponse(markdown: unknown, entryOverrides: Record<string, unknown> = {}): Response {
    return new Response(
      JSON.stringify({
        success: true,
        results: [{ url: "https://example.com", success: true, markdown, ...entryOverrides }],
      }),
      { status: 200 },
    );
  }

  it("is exported and directly usable as a FetchSite value (the wiring the design doc shows)", () => {
    // Not invoked here -- it's built on the real `globalThis.fetch`, so exercising it
    // would hit the real network. This only proves the exact literal wiring
    // `enrichmentProvider("llm-web", { client, fetchSite: crawl4aiFetchSite })` type-checks
    // and resolves to a callable FetchSite, matching research/10-sota-integration-design.md §2.5.
    expect(typeof crawl4aiFetchSite).toBe("function");
  });

  it("POSTs {urls:[url]} to <baseUrl>/crawl (trailing slash stripped) and returns Crawl4AI's fit_markdown", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return crawl4aiResponse({
        raw_markdown: "# nav\n\nExample Corp builds developer tools. [cookie banner] [nav junk]",
        fit_markdown: "Example Corp builds developer tools.",
      });
    };
    const fetchSite = createCrawl4aiFetchSite({ fetchImpl, baseUrl: "http://sidecar.local:11235/" });

    const text = await fetchSite("https://example.com");

    expect(text).toBe("Example Corp builds developer tools.");
    expect(calls).toEqual([{ url: "http://sidecar.local:11235/crawl", body: { urls: ["https://example.com"] } }]);
  });

  it("falls back to raw_markdown when fit_markdown is absent, and accepts a plain string markdown field", async () => {
    const rawOnly: typeof fetch = async () => crawl4aiResponse({ raw_markdown: "raw only, no fit filter" });
    const plainString: typeof fetch = async () => crawl4aiResponse("plain markdown string");

    const rawSite = createCrawl4aiFetchSite({ fetchImpl: rawOnly, baseUrl: "http://sidecar.local:11235" });
    const plainSite = createCrawl4aiFetchSite({ fetchImpl: plainString, baseUrl: "http://sidecar.local:11235" });

    expect(await rawSite("https://example.com")).toBe("raw only, no fit filter");
    expect(await plainSite("https://example.com")).toBe("plain markdown string");
  });

  it("falls back to defaultFetchSite (injected, so the test stays offline) on a non-OK sidecar response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("internal error", { status: 500 });
    const fallbackCalls: string[] = [];
    const fallbackFetchSite: FetchSite = async (url) => {
      fallbackCalls.push(url);
      return "fallback content";
    };
    const fetchSite = createCrawl4aiFetchSite({ fetchImpl, baseUrl: "http://sidecar.local:11235", fallbackFetchSite });

    const text = await fetchSite("https://example.com");

    expect(text).toBe("fallback content");
    expect(fallbackCalls).toEqual(["https://example.com"]);
  });

  it("falls back to defaultFetchSite (injected) when the sidecar is unreachable (fetch throws)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const fallbackFetchSite: FetchSite = async () => "fallback content";
    const fetchSite = createCrawl4aiFetchSite({ fetchImpl, baseUrl: "http://sidecar.local:11235", fallbackFetchSite });

    expect(await fetchSite("https://example.com")).toBe("fallback content");
  });

  it("falls back to defaultFetchSite (injected) on success:false or empty/whitespace-only content", async () => {
    const reportsFailure: typeof fetch = async () =>
      crawl4aiResponse(undefined, { success: false, error_message: "render timeout" });
    const emptyContent: typeof fetch = async () => crawl4aiResponse("   ");
    const fallbackFetchSite: FetchSite = async () => "fallback content";

    const failureSite = createCrawl4aiFetchSite({
      fetchImpl: reportsFailure,
      baseUrl: "http://sidecar.local:11235",
      fallbackFetchSite,
    });
    const emptySite = createCrawl4aiFetchSite({
      fetchImpl: emptyContent,
      baseUrl: "http://sidecar.local:11235",
      fallbackFetchSite,
    });

    expect(await failureSite("https://example.com")).toBe("fallback content");
    expect(await emptySite("https://example.com")).toBe("fallback content");
  });

  it("wired end-to-end via enrichmentProvider('llm-web', {fetchSite}) still tags source:'llm-web', leaving mergeEnrichment's registry>llm-web>paid trust order and per-field provenance unaffected", async () => {
    const client: ClaudeMessagesClient = {
      messages: {
        create: async () =>
          ({
            content: [
              {
                type: "tool_use",
                name: "emit_enrichment_record",
                input: { name: "Example Corp", employees: 42, industry: "SaaS", region: "US", tech: ["typescript"] },
              },
            ],
          }) satisfies ClaudeMessageResult,
      },
    };
    const crawl4aiCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      crawl4aiCalls.push(String(input));
      return crawl4aiResponse({ fit_markdown: "Example Corp builds developer tools for TypeScript teams." });
    };
    const fetchSite = createCrawl4aiFetchSite({ fetchImpl, baseUrl: "http://sidecar.local:11235" });

    const provider = enrichmentProvider("llm-web", { client, fetchSite });
    const llmRecord = await provider.enrich({ domain: "example.com" });

    // crawl4ai only changes *how* llm-web fetches site text -- the resulting record's
    // `source` (what mergeEnrichment ranks by) is unchanged.
    expect(llmRecord?.source).toBe("llm-web");
    expect(crawl4aiCalls).toEqual(["http://sidecar.local:11235/crawl"]);
    expect(llmRecord).not.toBeNull();

    const wikidataRecord: EnrichmentRecord = {
      domain: "example.com",
      name: "Example Corp (registry)",
      firmographic: { employees: 999, industry: "Software", region: "US", tech: [] },
      provenance: { employees: "wikidata", industry: "wikidata", region: "wikidata" },
      source: "wikidata",
    };
    const merged = mergeEnrichment([llmRecord as EnrichmentRecord, wikidataRecord]);
    expect(merged?.firmographic.employees).toBe(999); // registry still wins -- trust order untouched
    expect(merged?.provenance.employees).toBe("wikidata");
    expect(merged?.firmographic.tech).toEqual(["typescript"]); // llm-web still wins fields the registry lacks
    expect(merged?.provenance.tech).toBe("llm-web");
  });
});
