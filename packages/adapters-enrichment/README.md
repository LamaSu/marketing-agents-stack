# @mstack/adapters-enrichment

`EnrichmentProvider` seam implementations (see `packages/core/src/seams.ts`) — resolve
a company ref (`{domain, name?}`) to an `EnrichmentRecord` (firmographic + contacts +
per-field provenance). See `research/06-architecture.md` §3.2/§5.1 and
`research/tools/B-enrichment-data.md`.

## Providers

| Provider | class | `source` tag | network? | keys? |
|---|---|---|---|---|
| **sample** (default, offline) | `SampleProvider` | `sample` | no | no |
| **llm-web** (the paid-vendor replacement) | `LlmWebProvider` | `llm-web` | yes (site fetch + Claude) | yes (Claude) |
| **wikidata** | `WikidataProvider` | `wikidata` | yes (query.wikidata.org) | no |
| **gleif** | `GleifProvider` | `gleif` | yes (api.gleif.org) | no |
| **edgar** | `EdgarProvider` | `edgar` | yes (data.sec.gov) | no |

Plus two standalone helpers (not `EnrichmentProvider`s — narrower jobs):

- `checkEmail` / `guessEmail` (`email.ts`) — local syntax + MX check, no vendor.
- `detectTech` (`techdetect.ts`) — **stub**, always returns `tech: []`; wraps
  `wappalyzergo` in a later wave.

## Everything network/LLM-touching is injectable

Every provider that talks to the network takes an injectable dependency, defaulted
only where a sane offline default exists:

- `SampleProvider({ fixturePath?, fixtures? })` — no network at all; reads
  `data/accounts.sample.json` by default (three `..` up from `src/`/`dist/` lands on
  the repo root), or an in-memory `fixtures` array for tests.
- `WikidataProvider` / `GleifProvider` / `EdgarProvider({ fetchImpl?, userAgent? })` —
  `fetchImpl` defaults to `globalThis.fetch`; inject a fake in tests.
- `LlmWebProvider({ client, fetchSite? })` — `client` is **required** (no offline
  default — there's no sane default for "call a paid-tier LLM"); `fetchSite` defaults
  to a plain `fetch` + tag-strip, or inject a Crawl4AI-backed fetcher for production
  quality.
- `checkEmail(email, { resolveMx?, skipMx? })` — `resolveMx` defaults to
  `node:dns/promises` `resolveMx`; inject a fake or pass `skipMx: true`.

This is what keeps this package's own test suite (`src/index.test.ts`) 100% offline —
zero network calls, zero credentials — matching `docs/build-conventions.md`'s "write
correct code + tests; do not install or run the build locally."

## `mergeEnrichment`

```ts
import { mergeEnrichment } from "@mstack/adapters-enrichment";

const merged = mergeEnrichment([llmWebRecord, wikidataRecord, gleifRecord]);
// merged.firmographic.employees came from whichever record ranked highest trust AND
// had a non-empty value for that field; merged.provenance.employees names the source.
```

Trust order (highest first): **the CC0 registries (`wikidata`/`gleif`/`edgar`) and the
offline `sample` fixture > `llm-web` > everything else** (opt-in paid vendors this
package doesn't ship — `pdl`/`hunter`/`opencorporates` per
`research/tools/B-enrichment-data.md` §12 would rank last if merged in). Every field is
resolved **by trust, never averaged**: the highest-trust record that has a non-empty
value for a field wins that field outright, and `provenance[field]` records which
source won. Fields are atomic — one winning source per field, never unioned across
sources — because `Provenance` (`packages/core`) maps one field name to exactly one
source string.

## `enrichmentProvider(name, config?)` factory

```ts
import { enrichmentProvider } from "@mstack/adapters-enrichment";
import Anthropic from "@anthropic-ai/sdk";

const provider = enrichmentProvider(); // SampleProvider, offline, zero config
const wikidata = enrichmentProvider("wikidata");
const llmWeb = enrichmentProvider("llm-web", {
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), // structurally satisfies ClaudeMessagesClient
});
```

## Known simplifications (assumptions to verify on the Spark build)

This package was written without running `pnpm install` locally
(`docs/build-conventions.md`) — the following are documented assumptions, not verified
against a live call or the installed `@anthropic-ai/sdk` types:

- **Registry response shapes** (Wikidata SPARQL JSON results, GLEIF `lei-records`
  JSON:API, SEC EDGAR `submissions/CIK##########.json`) are coded from each service's
  public docs, not a live call. Every parse is defensive (optional chaining, try/catch
  around fetch+JSON) so an unexpected real-world shape degrades to `null`/omitted
  fields rather than throwing.
- **GLEIF and EDGAR are name-indexed, not domain-indexed.** Given only `{domain}` (no
  `name`), both derive a name guess from the domain label (`stripe.com` -> `"stripe"`).
  This is a best-effort heuristic, not an exact-match guarantee — pass `ref.name` when
  you have it for a materially better hit rate. EDGAR additionally skips the lookup
  entirely (no fetch call) when the guessed name is under 3 characters — too weak a
  signal to search reliably.
- **EDGAR uses the `submissions` endpoint**, not `companyfacts`/XBRL — its shape
  (`name`, `sicDescription`, `addresses.business.stateOrCountry`) maps directly onto
  `Firmographic{industry,region}`. `companyfacts` carries richer financials but needs
  per-concept XBRL tag parsing; left for a follow-up wave.
- **`LlmWebProvider`'s `client` param is typed against a minimal hand-declared
  `ClaudeMessagesClient` interface** (`messages.create({...}) -> {content: [...]}`),
  not an import of `@anthropic-ai/sdk`'s own exported types — this session couldn't
  verify the SDK's exact nested type-export names without a local install. A real
  `new Anthropic({ apiKey })` instance satisfies this interface structurally (duck
  typing). If a real call-shape mismatch surfaces on the Spark build, widen
  `ClaudeMessageParams`/`ClaudeMessageResult` in `llm-web.ts` — the provider logic
  itself doesn't change.
- **`mergeEnrichment` ranks `sample` alongside the CC0 registries** (both rank 0)
  since it stands in for registry-grade ground truth offline; this isn't stated
  explicitly in the architecture doc's `registry(CC0) > llm-web > paid` rule and is
  this package's own reasonable extension of that rule to cover the offline default.
- **`techdetect.ts` is a stub** (always returns `tech: []`) per the task scope — real
  `wappalyzergo` (Go binary) wrapping is left for a later wave, exactly as
  `research/tools/B-enrichment-data.md` §2 recommends adopting it.
- **`email.ts` never does live SMTP probing** (syntax + MX/DNS + role/free-provider
  heuristics only) — per `research/tools/B-enrichment-data.md` §8, live SMTP probing
  is unreliable and risks sender-IP blacklisting. Swapping in `AfterShip/email-verifier`
  (Go, MIT) for the fuller local check (catch-all/disposable-domain detection) is a
  documented future option, not built here.

## Tests

`src/index.test.ts`, fully offline (`vitest run`):

- `SampleProvider` returns a full record for a fixture domain (and `null` for an
  unknown one); an injected `fixtures` array bypasses the filesystem entirely.
- `mergeEnrichment` resolves a conflicting field by trust order (registry beats
  llm-web), keeps correct per-field provenance, and is demonstrably not averaging.
- `enrichmentProvider()` factory wiring, including the required-`client` guard for
  `"llm-web"`.
- `checkEmail` / `guessEmail` syntax, MX (via an injected fake resolver), role-account
  and free-provider heuristics.
- `WikidataProvider` / `GleifProvider` / `EdgarProvider` parse canned fetch responses
  into partial records with correct provenance, and return `null` gracefully on an
  empty/malformed response or a non-OK status.
- `LlmWebProvider` extracts a valid `EnrichmentRecord` from a canned `fetchSite` +
  canned Claude tool-use response, and returns `null` when the site is unreachable,
  the model returns no tool-use block, or the extraction fails zod validation.
