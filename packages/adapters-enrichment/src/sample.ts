/**
 * SampleProvider — the offline default `EnrichmentProvider` (packages/core `seams.ts`).
 * Reads `data/accounts.sample.json` (EnrichmentRecord-shaped fixtures, see
 * `data/README.md`) and returns the matching row for a domain. Zero network, zero
 * keys — this is what `mstack demo` runs on with no credentials
 * (research/06-architecture.md §5.1/§5.2).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnrichmentProvider, EnrichmentRecord } from "@mstack/core";

export interface SampleProviderConfig {
  /** override the fixture file path (mainly for tests). */
  fixturePath?: string;
  /** pre-loaded fixture rows — bypasses the filesystem entirely when supplied (tests). */
  fixtures?: EnrichmentRecord[];
}

/**
 * packages/adapters-enrichment/{src|dist}/sample.ts -> <repo root>/data/accounts.sample.json.
 * Both `src/` and the built `dist/` sit exactly two directories under the repo root
 * (`packages/adapters-enrichment/`), so the same "../../../" resolves correctly whether
 * this runs from source (vitest) or from the compiled output.
 */
function defaultFixturePath(): string {
  return fileURLToPath(new URL("../../../data/accounts.sample.json", import.meta.url));
}

export class SampleProvider implements EnrichmentProvider {
  readonly name = "sample";
  #records: EnrichmentRecord[] | undefined;
  readonly #fixturePath: string;

  constructor(config: SampleProviderConfig = {}) {
    this.#records = config.fixtures;
    this.#fixturePath = config.fixturePath ?? defaultFixturePath();
  }

  #load(): EnrichmentRecord[] {
    if (!this.#records) {
      const raw = readFileSync(this.#fixturePath, "utf8");
      this.#records = JSON.parse(raw) as EnrichmentRecord[];
    }
    return this.#records;
  }

  /** Returns null if no fixture row matches this domain (case-insensitive, trimmed). */
  async enrich(ref: { domain: string; name?: string }): Promise<EnrichmentRecord | null> {
    const domain = ref.domain.trim().toLowerCase();
    const match = this.#load().find((r) => r.domain.trim().toLowerCase() === domain);
    return match ?? null;
  }
}
