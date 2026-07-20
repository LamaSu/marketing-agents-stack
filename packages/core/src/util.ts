/** Small shared helpers used across packages (ids, timestamps, audit hashing). */
import { createHash, randomUUID } from "node:crypto";

/** Prefixed id, e.g. newId("sig") -> "sig_9f2c...". Prefixes make ids self-describing in the warehouse. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Hex SHA-256 — used to chain the Approval audit log (hash = H(prevHash + payload)). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The genesis hash for a fresh hash-chain. */
export const GENESIS_HASH = "0".repeat(64);
