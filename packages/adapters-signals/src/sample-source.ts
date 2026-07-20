/**
 * SampleSource -- the DEFAULT, offline SignalSource. Reads the bundled
 * data/signals.sample.jsonl fixture (85 rows spanning product_usage/crm/campaign/intent --
 * see data/README.md) and returns it as validated Signal[]. Zero network, zero credentials:
 * this is what makes `pnpm mstack seed && pnpm mstack demo` run end-to-end offline
 * (research/06-architecture.md §5.2).
 *
 * Path resolution: relative to THIS file's own location (via import.meta.url), not
 * process.cwd() -- so it finds data/signals.sample.jsonl regardless of which directory the
 * process was launched from. Override with `dataDir` (ctor) or the SAMPLE_DATA_DIR env var
 * (precedence: ctor > env > computed default) for a standalone install outside this monorepo,
 * or to point at a different fixture set.
 *
 * If the real file can't be read (missing, permissions, SAMPLE_DATA_DIR misconfigured, or this
 * package used standalone without the repo's data/ dir) this NEVER throws -- it logs a warning
 * and falls back to a tiny inline fixture, so "runs offline with zero deps" holds even then.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Signal } from "@mstack/core";
import type { PullOptions, SignalSource } from "@mstack/core";

import { applyPullOptions } from "./util.js";

export interface SampleSourceConfig {
  name?: string;
  /** overrides the sample-data directory. Precedence: this > SAMPLE_DATA_DIR env > repo-root data/. */
  dataDir?: string;
  /** filename within dataDir. Defaults to "signals.sample.jsonl". */
  fileName?: string;
}

/** Tiny inline fallback -- only used if the real fixture file can't be read. Synthetic, in the
 *  same spirit as data/README.md's fixture-data disclaimer (fictional company/person data). */
const FALLBACK_SIGNALS: ReadonlyArray<Record<string, unknown>> = [
  {
    id: "sig_fallback_0001",
    ts: "2026-01-01T00:00:00.000Z",
    source: "sample",
    kind: "product_usage",
    actor: { anonId: "anon_fallback1", company: "example.com" },
    action: "docs_viewed",
    properties: { page: "/docs/quickstart" },
  },
  {
    id: "sig_fallback_0002",
    ts: "2026-01-02T00:00:00.000Z",
    source: "sample",
    kind: "intent",
    actor: { anonId: "anon_fallback2", company: "example.com" },
    action: "github_starred_repo",
    properties: { repo: "mstack/signal-adapters" },
  },
];

/** repo-root data/ dir, resolved relative to this file's own location -- works identically
 *  whether this runs from src/*.ts (vitest/tsx) or the compiled dist/*.js, because both sit
 *  three path segments below the repo root (packages/adapters-signals/{src,dist}/...). */
function defaultDataDir(): string {
  return fileURLToPath(new URL("../../../data", import.meta.url));
}

function parseJsonl(raw: string): Signal[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Signal.parse(JSON.parse(line)));
}

export class SampleSource implements SignalSource {
  readonly name: string;
  readonly #dataDir: string | undefined;
  readonly #fileName: string;

  constructor(config: SampleSourceConfig = {}) {
    this.name = config.name ?? "sample";
    this.#dataDir = config.dataDir;
    this.#fileName = config.fileName ?? "signals.sample.jsonl";
  }

  async pull(opts?: PullOptions): Promise<Signal[]> {
    const signals = await this.#load();
    return applyPullOptions(signals, opts);
  }

  #resolvePath(): string {
    const dir = this.#dataDir ?? process.env["SAMPLE_DATA_DIR"] ?? defaultDataDir();
    return join(dir, this.#fileName);
  }

  async #load(): Promise<Signal[]> {
    const path = this.#resolvePath();
    try {
      const raw = await readFile(path, "utf8");
      return parseJsonl(raw);
    } catch (err) {
      console.warn(
        `[@mstack/adapters-signals] SampleSource: could not read ${path} (${String(err)}); using the inline fallback fixture instead`,
      );
      return FALLBACK_SIGNALS.map((row) => Signal.parse(row));
    }
  }
}
