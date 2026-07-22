/**
 * SampleOutcomeSource -- the DEFAULT, offline OutcomeSource. Reads this package's own
 * bundled data/outcomes.sample.jsonl fixture (8 rows: four dispatched drafts followed by
 * their reply/meeting/no_response return-leg outcomes) and returns it as validated
 * Outcome[]. Zero network, zero credentials -- the same "runs offline by default" contract
 * as adapters-signals' SampleSource (see that file's header) applied to the RETURN leg: a
 * fresh install of this package can demonstrate stop-on-reply / qualifier-label /
 * analytics-funnel consumers with nothing but this file on disk.
 *
 * Deliberately package-local data (packages/adapters-outcomes/data/), NOT the shared
 * repo-root data/ directory: that directory is its own workspace package (`@mstack/data`)
 * with its own validate.test.ts asserting every file's shape -- adding a file there would
 * require touching that package's test, out of this package's scope. Self-contained data
 * keeps this package independently installable and change-isolated.
 *
 * Path resolution: relative to THIS file's own location (import.meta.url), not
 * process.cwd(), so it finds data/outcomes.sample.jsonl regardless of which directory the
 * process was launched from -- and works identically from src/*.ts (vitest/tsx) or
 * compiled dist/*.js, because both sit ONE path segment below this package's own root
 * (packages/adapters-outcomes/{src,dist}/... -> ../data). Override with `dataDir` (ctor) or
 * the OUTCOME_SAMPLE_DATA_DIR env var (precedence: ctor > env > computed default) --
 * intentionally a DIFFERENT env var name than adapters-signals' SAMPLE_DATA_DIR, so
 * pointing one package at an alternate fixture directory never accidentally repoints the
 * other.
 *
 * If the real file can't be read (missing, permissions, OUTCOME_SAMPLE_DATA_DIR
 * misconfigured, or this package used standalone without its own data/ dir) this NEVER
 * throws -- it logs a warning and falls back to a tiny inline fixture, matching
 * SampleSource's degrade-safe contract exactly.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Outcome } from "@mstack/core";
import type { PullOptions } from "@mstack/core";

import type { OutcomeSource } from "./outcome-source.js";
import { applyPullOptions } from "./util.js";

export interface SampleOutcomeSourceConfig {
  name?: string;
  /** overrides this package's own sample-data directory. Precedence: this >
   *  OUTCOME_SAMPLE_DATA_DIR env > this package's own data/. */
  dataDir?: string;
  /** filename within dataDir. Defaults to "outcomes.sample.jsonl". */
  fileName?: string;
}

/** Tiny inline fallback -- only used if the real fixture file can't be read. Synthetic,
 *  same fixture-data disclaimer as data/README.md (fictional refIds, not real accounts). */
const FALLBACK_OUTCOMES: ReadonlyArray<Record<string, unknown>> = [
  {
    id: "out_fallback_0001",
    refType: "draft",
    refId: "dr_fallback_0001",
    result: "replied",
    ts: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "out_fallback_0002",
    refType: "draft",
    refId: "dr_fallback_0002",
    result: "no_response",
    ts: "2026-01-02T00:00:00.000Z",
  },
];

/** this package's own data/ dir, resolved relative to this file's own location -- works
 *  identically whether this runs from src/*.ts or the compiled dist/*.js, because both sit
 *  one path segment below the package root (packages/adapters-outcomes/{src,dist}/...). */
function defaultDataDir(): string {
  return fileURLToPath(new URL("../data", import.meta.url));
}

function parseJsonl(raw: string): Outcome[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Outcome.parse(JSON.parse(line)));
}

export class SampleOutcomeSource implements OutcomeSource {
  readonly name: string;
  readonly #dataDir: string | undefined;
  readonly #fileName: string;

  constructor(config: SampleOutcomeSourceConfig = {}) {
    this.name = config.name ?? "sample";
    this.#dataDir = config.dataDir;
    this.#fileName = config.fileName ?? "outcomes.sample.jsonl";
  }

  async pull(opts?: PullOptions): Promise<Outcome[]> {
    const outcomes = await this.#load();
    return applyPullOptions(outcomes, opts);
  }

  #resolvePath(): string {
    const dir = this.#dataDir ?? process.env["OUTCOME_SAMPLE_DATA_DIR"] ?? defaultDataDir();
    return join(dir, this.#fileName);
  }

  async #load(): Promise<Outcome[]> {
    const path = this.#resolvePath();
    try {
      const raw = await readFile(path, "utf8");
      return parseJsonl(raw);
    } catch (err) {
      console.warn(
        `[@mstack/adapters-outcomes] SampleOutcomeSource: could not read ${path} (${String(err)}); using the inline fallback fixture instead`,
      );
      return FALLBACK_OUTCOMES.map((row) => Outcome.parse(row));
    }
  }
}

/** Convenience factory, mirroring this package's other `*OutcomeSource` constructors --
 *  used by `factory.ts`'s `outcomeSource("sample", config)`. */
export function sampleOutcomeSource(config?: SampleOutcomeSourceConfig): SampleOutcomeSource {
  return new SampleOutcomeSource(config);
}
