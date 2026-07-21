/**
 * seed.ts — self-seed guard for a fresh `DATA_DIR`.
 *
 * If `mstack seed` (apps/cli) was never run against this `DATA_DIR`, the portal
 * seeds the guideline rule rows + the reviewer's LanceDB corpus itself on boot —
 * mirrors `apps/cli/src/seed.ts` steps 3-4 exactly (same rows, same guarded
 * ingest). The portal never needs that file's steps 1-2 (signals / enrichment
 * fixtures) — those feed the account-activation workflow, which this app does
 * not run. Idempotent: re-running against an already-seeded warehouse is a no-op
 * (checked via `memory.listGuidelines()`), matching `runSeed`'s own idempotency.
 */
import { createLanceCorpus, FakeEmbedder, HuggingFaceEmbedder, loadGuidelinesJson } from "@mstack/reviewer";
import type { MemoryRepo } from "@mstack/memory";

import type { Mode } from "./context.js";

export interface SelfSeedResult {
  /** true iff this call actually wrote guideline rows (the warehouse was empty). */
  seeded: boolean;
  guidelines: number;
}

export async function selfSeedIfEmpty(memory: MemoryRepo, mode: Mode, lanceDir: string): Promise<SelfSeedResult> {
  const existing = await memory.listGuidelines();
  if (existing.length > 0) {
    return { seeded: false, guidelines: existing.length };
  }

  const guidelines = await loadGuidelinesJson();
  for (const guideline of guidelines) {
    await memory.putGuideline(guideline);
  }

  // Guarded exactly like apps/cli/src/seed.ts step 4 — a native LanceDB hiccup
  // degrades to a warning, never blocks boot (offline scanning doesn't need it;
  // it reads guideline ROWS, not embedded passages).
  try {
    const embedder = mode === "live" ? new HuggingFaceEmbedder() : new FakeEmbedder();
    const corpus = createLanceCorpus({ dbPath: lanceDir, embedder });
    await corpus.ingest(guidelines);
  } catch (err) {
    console.warn(`[portal] LanceDB corpus ingest skipped on self-seed (not required for offline scanning): ${String(err)}`);
  }

  return { seeded: true, guidelines: guidelines.length };
}
