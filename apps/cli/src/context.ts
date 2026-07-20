/**
 * context.ts — mode detection, path resolution, and the one shared `MemoryRepo`
 * instance every `mstack` subcommand runs against.
 *
 * MODE (research/06-architecture.md §5.2): the demo is `live` iff
 * `ANTHROPIC_API_KEY` is set, else `offline`. Offline runs the deterministic +
 * rules + fixture path so the whole loop is provable with zero cost and zero
 * network; live swaps in Claude for extraction/judgment/copy behind the SAME
 * subcommands.
 *
 * SINGLE-WRITER DISCIPLINE (@mstack/memory): DuckDB is single-writer, so each
 * command opens exactly ONE `MemoryRepo` via `openContext()`, shares it across
 * the whole command, and `close()`s it when done (see `cli.ts`'s `finally`).
 */
import { join } from "node:path";

import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import { DraftStore } from "@mstack/runtime";

export type Mode = "live" | "offline";

type EnvLike = Record<string, string | undefined>;

/** `live` iff a non-empty `ANTHROPIC_API_KEY` is present, else `offline`. */
export function detectMode(env: EnvLike = process.env): Mode {
  const key = env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? "live" : "offline";
}

export interface ResolvedPaths {
  /** warehouse + corpus root (DATA_DIR env, default ./.data). */
  dataDir: string;
  /** the DuckDB file `openMemory` opens. */
  dbPath: string;
  /** where `DraftStore` writes the human-glanceable draft files (DRAFTS_DIR env, default ./drafts). */
  draftsDir: string;
  /** where `LocalOutreachChannel` writes dispatched sends (OUTBOX_DIR env, default ./outbox). */
  outboxDir: string;
  /** LanceDB directory for the reviewer corpus (LANCE_DIR env, default <dataDir>/lancedb). */
  lanceDir: string;
}

export interface ContextOverrides {
  mode?: Mode;
  dataDir?: string;
  draftsDir?: string;
  outboxDir?: string;
  lanceDir?: string;
}

/** Resolve every path from explicit override > env var > sensible default. The
 *  defaults mirror `@mstack/memory` (`./.data`), `DraftStore` (`./drafts`), and
 *  `LocalOutreachChannel` (`./outbox`) so the CLI and those packages agree. */
export function resolvePaths(overrides: ContextOverrides = {}, env: EnvLike = process.env): ResolvedPaths {
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? "./.data";
  return {
    dataDir,
    dbPath: join(dataDir, "memory.duckdb"),
    draftsDir: overrides.draftsDir ?? env.DRAFTS_DIR ?? "./drafts",
    outboxDir: overrides.outboxDir ?? env.OUTBOX_DIR ?? "./outbox",
    lanceDir: overrides.lanceDir ?? env.LANCE_DIR ?? join(dataDir, "lancedb"),
  };
}

export interface CliContext {
  mode: Mode;
  memory: MemoryRepo;
  draftStore: DraftStore;
  paths: ResolvedPaths;
}

/**
 * Open the shared warehouse + draft store for one command. The caller owns
 * closing it (`ctx.memory.close()`), per the single-writer discipline.
 */
export async function openContext(overrides: ContextOverrides = {}): Promise<CliContext> {
  const mode = overrides.mode ?? detectMode();
  const paths = resolvePaths(overrides);
  const memory = await openMemory(paths.dbPath);
  const draftStore = new DraftStore(memory, paths.draftsDir);
  return { mode, memory, draftStore, paths };
}
