import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENESIS_HASH } from "@mstack/core";

import { openMemory } from "./index.js";
import type { MemoryRepo } from "./index.js";
import { exportAuditHalo, writeHaloAudit, verifyHaloChain } from "./halo-export.js";
import type { HaloRecord } from "./halo-export.js";

const now = "2026-07-21T00:00:00.000Z";

/** A 3-approval chain in a fresh in-memory MemoryRepo — one of each decision. */
async function chainOfThree(): Promise<MemoryRepo> {
  const repo = await openMemory(":memory:");
  await repo.appendApproval({ id: "ap1", draftId: "dr1", decision: "approve", actor: "alice", ts: now });
  await repo.appendApproval({
    id: "ap2",
    draftId: "dr2",
    decision: "reject",
    actor: "bob",
    ts: now,
    note: "off-brand",
  });
  await repo.appendApproval({ id: "ap3", reviewId: "r1", decision: "edit", actor: "carol", ts: now });
  return repo;
}

describe("exportAuditHalo — halo-record-format audit export (packages/memory/src/halo-export.ts)", () => {
  let repo: MemoryRepo;

  // Fresh 3-approval chain before every test (mirrors memory-repo.test.ts's
  // own beforeEach/afterEach discipline — never reuse/double-close a repo
  // across tests). The one test that needs a DIFFERENT repo (no approvals)
  // opens and closes its own local instance instead of touching this one.
  beforeEach(async () => {
    repo = await chainOfThree();
  });

  afterEach(async () => {
    await repo.close();
  });

  it("exports the approvals chain as 3 halo records with correct prev-hash links", async () => {
    const records = await exportAuditHalo(repo);

    expect(records).toHaveLength(3);
    const [r1, r2, r3] = records;
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();

    // chain linkage: genesis -> r1.hash -> r2.hash -> r3.hash
    expect(r1!.integrity.prev_hash).toBe(GENESIS_HASH);
    expect(r2!.integrity.prev_hash).toBe(r1!.integrity.hash);
    expect(r3!.integrity.prev_hash).toBe(r2!.integrity.hash);
    // and every hash actually differs (not a no-op chain)
    expect(new Set([r1!.integrity.hash, r2!.integrity.hash, r3!.integrity.hash]).size).toBe(3);

    // envelope shape (halo-record schema v0.1)
    for (const r of records) {
      expect(r.schema_version).toBe("0.1");
      expect(r.session_id).toBe("mstack-approvals");
      expect(r.integrity.alg).toBe("sha-256");
      expect(r.integrity.canon).toBe("rfc8785");
    }
    expect(r1!.record_id).toBe("ap1");
    expect(r2!.record_id).toBe("ap2");
    expect(r3!.record_id).toBe("ap3");

    // decision -> authorization mapping
    expect(r1!.action.authorization).toBe("human_approved"); // approve
    expect(r2!.action.authorization).toBe("denied"); // reject
    expect(r3!.action.authorization).toBe("human_approved"); // edit (no "edited" state in halo's enum)

    // seq + full original Approval preserved losslessly in the mstack extension
    expect(r1!.mstack.seq).toBe(1);
    expect(r2!.mstack.seq).toBe(2);
    expect(r3!.mstack.seq).toBe(3);
    expect(r2!.mstack.approval.note).toBe("off-brand");
    expect(r3!.mstack.approval.decision).toBe("edit");
  });

  it("re-verifies cleanly on a clean chain and fails on a tampered record", async () => {
    const records = await exportAuditHalo(repo);

    expect(verifyHaloChain(records)).toBe(true);

    // Simulate an attacker editing an exported record's content while leaving
    // its stored integrity.hash stale — mirrors memory-repo.test.ts's own
    // internal tamper test, one layer up (the halo-format envelope).
    const tampered: HaloRecord[] = records.map((r, i) =>
      i === 1 ? { ...r, action: { ...r.action, authorization: "human_approved" as const } } : r,
    );
    expect(verifyHaloChain(tampered)).toBe(false);

    // tampering the LAST record's prev_hash link (breaking chain linkage
    // rather than content hashing) must also be caught
    const brokenLink: HaloRecord[] = records.map((r, i) =>
      i === 2 ? { ...r, integrity: { ...r.integrity, prev_hash: GENESIS_HASH } } : r,
    );
    expect(verifyHaloChain(brokenLink)).toBe(false);

    // untouched export is unaffected by the mutations above (no shared references)
    expect(verifyHaloChain(records)).toBe(true);
  });

  it("leaves the internal welded chain untouched — verifyAuditChain still passes after exporting", async () => {
    expect(await repo.verifyAuditChain()).toBe(true);

    await exportAuditHalo(repo); // read-only export must not mutate the source chain

    expect(await repo.verifyAuditChain()).toBe(true);
    // the internal chain's own hashes are computed by a different algorithm
    // than halo's (prevHash-prefixed sha256 vs RFC-8785-canonicalized sha256)
    // and must never be conflated with a halo record's integrity.hash.
    const internal = await repo.query<{ hash: string }>("SELECT hash FROM approvals ORDER BY seq ASC");
    const halo = await exportAuditHalo(repo);
    expect(internal.map((row) => row.hash)).not.toEqual(halo.map((r) => r.integrity.hash));
  });

  it("writeHaloAudit writes a valid JSON file (creating parent dirs) matching exportAuditHalo's output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "halo-audit-"));
    const outPath = join(dir, "nested", "audit.json"); // exercises mkdir -p
    try {
      const written = await writeHaloAudit(repo, outPath);
      expect(written).toHaveLength(3);

      const onDisk = JSON.parse(await readFile(outPath, "utf8")) as HaloRecord[];
      expect(onDisk).toHaveLength(3);
      expect(onDisk[0]?.record_id).toBe("ap1");
      expect(verifyHaloChain(onDisk)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces an empty array for a warehouse with no approvals", async () => {
    const emptyRepo = await openMemory(":memory:");
    try {
      expect(await exportAuditHalo(emptyRepo)).toEqual([]);
      expect(verifyHaloChain([])).toBe(true); // vacuously — nothing to contradict
    } finally {
      await emptyRepo.close();
    }
  });
});
