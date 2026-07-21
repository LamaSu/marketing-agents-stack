/**
 * context.ts — mode detection, path resolution, and the shared `MemoryRepo` +
 * `DraftStore` the portal server runs against.
 *
 * Mirrors `apps/cli/src/context.ts` deliberately (same env vars, same
 * defaults, same `live` iff `ANTHROPIC_API_KEY` rule) so the portal and the
 * CLI agree on where the warehouse/drafts/outbox/corpus live when pointed at
 * the same `DATA_DIR` — see docs/build-conventions.md: DuckDB is
 * single-writer, so only one app may hold it open at a time. Apps don't
 * import each other's internals in this repo (only `packages/*` are shared),
 * so this is a small, deliberate duplication rather than a cross-app import.
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
  /** where `DraftStore` writes human-glanceable draft files (DRAFTS_DIR env, default ./drafts). */
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
  port?: number;
}

/** Resolve every path from explicit override > env var > sensible default — identical
 *  defaulting to `apps/cli/src/context.ts` so both apps agree when pointed at the same dirs. */
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

const DEFAULT_PORT = 4310;

/** Resolve the HTTP port: explicit override > PORT env > 4310. `0` is accepted (it is a
 *  meaningful value to Node's `listen()` — "let the OS assign a free port"). */
export function resolvePort(overrides: ContextOverrides = {}, env: EnvLike = process.env): number {
  if (typeof overrides.port === "number" && Number.isFinite(overrides.port) && overrides.port >= 0) {
    return overrides.port;
  }
  const raw = env.PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
}

export interface PortalContext {
  mode: Mode;
  memory: MemoryRepo;
  draftStore: DraftStore;
  paths: ResolvedPaths;
  port: number;
}

/**
 * Open the shared warehouse + draft store for the portal process. The caller owns closing it
 * (`ctx.memory.close()`), per the single-writer discipline documented above.
 */
export async function openPortalContext(overrides: ContextOverrides = {}): Promise<PortalContext> {
  const mode = overrides.mode ?? detectMode();
  const paths = resolvePaths(overrides);
  const port = resolvePort(overrides);
  const memory = await openMemory(paths.dbPath);
  const draftStore = new DraftStore(memory, paths.draftsDir);
  return { mode, memory, draftStore, paths, port };
}
