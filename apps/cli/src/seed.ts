/**
 * seed.ts — `mstack seed`. Loads the bundled offline fixtures into the
 * compounding warehouse + the reviewer corpus (research/06-architecture.md §5.2,
 * §7 W5-T3). Idempotent: every write upserts by a stable fixture id and the
 * corpus ingest overwrites, so re-running `seed` converges to the same state.
 *
 *   1. signals    → SampleSource → memory.putSignal (85 rows)
 *   2. accounts   → validate + count the enrichment fixtures (NOT persisted as
 *                   Account rows — Accounts are resolved at activation time by
 *                   `resolveAccount`; persisting random-id rows here would break
 *                   idempotency and duplicate the seam's own data)
 *   3. guidelines → guidelines.json → memory.putGuideline (20 rows)
 *   4. corpus     → ingest approved_messaging rows into a LanceCorpus with the
 *                   mode embedder (offline=FakeEmbedder, no network/model
 *                   download; live=HuggingFaceEmbedder). Guarded: a native
 *                   LanceDB hiccup degrades to a warning — the offline demo only
 *                   needs DuckDB, so a corpus miss must never break `seed`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SampleSource } from "@mstack/adapters-signals";
import { createLanceCorpus, FakeEmbedder, HuggingFaceEmbedder, loadGuidelinesJson } from "@mstack/reviewer";

import type { CliContext } from "./context.js";

export interface SeedResult {
  mode: CliContext["mode"];
  signals: number;
  guidelines: number;
  enrichmentFixtures: number;
  /** rows embedded into the LanceDB corpus; -1 if the ingest was skipped (native LanceDB unavailable). */
  corpusPassages: number;
}

const ACCOUNTS_FIXTURE = fileURLToPath(new URL("../../../data/accounts.sample.json", import.meta.url));

/** Count (and lightly validate) the enrichment fixtures without persisting them. */
async function countEnrichmentFixtures(): Promise<number> {
  const raw: unknown = JSON.parse(await readFile(ACCOUNTS_FIXTURE, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`seed: expected a JSON array at ${ACCOUNTS_FIXTURE}`);
  }
  for (const row of raw) {
    if (typeof row !== "object" || row === null || typeof (row as { domain?: unknown }).domain !== "string") {
      throw new Error(`seed: an enrichment fixture row is missing a string "domain"`);
    }
  }
  return raw.length;
}

export async function runSeed(ctx: CliContext): Promise<SeedResult> {
  const { memory, mode } = ctx;

  // 1. signals
  const signals = await new SampleSource().pull();
  for (const signal of signals) {
    await memory.putSignal(signal);
  }

  // 2. enrichment fixtures (validate + count only)
  const enrichmentFixtures = await countEnrichmentFixtures();

  // 3. guidelines
  const guidelines = await loadGuidelinesJson();
  for (const guideline of guidelines) {
    await memory.putGuideline(guideline);
  }

  // 4. corpus (guarded — degrade to a warning, never break seed)
  let corpusPassages = -1;
  try {
    const embedder = mode === "live" ? new HuggingFaceEmbedder() : new FakeEmbedder();
    const corpus = createLanceCorpus({ dbPath: ctx.paths.lanceDir, embedder });
    await corpus.ingest(guidelines);
    corpusPassages = await corpus.count();
  } catch (err) {
    console.warn(`[mstack seed] LanceDB corpus ingest skipped (offline demo does not require it): ${String(err)}`);
  }

  return {
    mode,
    signals: signals.length,
    guidelines: guidelines.length,
    enrichmentFixtures,
    corpusPassages,
  };
}
