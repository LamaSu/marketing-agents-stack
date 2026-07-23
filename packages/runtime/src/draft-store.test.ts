import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Draft, GENESIS_HASH } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "./draft-store.js";

const now = "2026-07-20T00:00:00.000Z";

function draftInput(overrides: Partial<Draft> = {}): Draft {
  return Draft.parse({
    id: "dr_store1",
    kind: "outreach_email",
    refId: "acc_1",
    subject: "hello",
    body: "hi there",
    createdBy: "test",
    createdAt: now,
    ...overrides,
  });
}

describe("DraftStore", () => {
  let memory: MemoryRepo;
  let draftsDir: string;
  let store: DraftStore;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-runtime-drafts-"));
    store = new DraftStore(memory, draftsDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
  });

  describe("save", () => {
    it("always lands status:'pending', even if the caller passed a different status", async () => {
      const saved = await store.save(draftInput({ status: "approved" }));
      expect(saved.status).toBe("pending");

      const persisted = await memory.getDraft(saved.id);
      expect(persisted?.status).toBe("pending");
    });

    it("writes <draftsDir>/<id>.json with the full draft", async () => {
      const saved = await store.save(draftInput());
      const written = JSON.parse(await readFile(join(draftsDir, `${saved.id}.json`), "utf8")) as Draft;
      expect(written.id).toBe(saved.id);
      expect(written.body).toBe(saved.body);
      expect(written.status).toBe("pending");
    });
  });

  describe("listPending", () => {
    it("returns only drafts with status:'pending', not approved/rejected/dispatched ones", async () => {
      await store.save(draftInput({ id: "dr_a", createdAt: "2026-07-20T00:00:01.000Z" }));
      await store.save(draftInput({ id: "dr_b", createdAt: "2026-07-20T00:00:02.000Z" }));
      await store.approve("dr_a", "human"); // dr_a -> approved, should drop out of listPending

      const pending = await store.listPending();
      expect(pending.map((d) => d.id)).toEqual(["dr_b"]);
    });

    it("returns an empty array when nothing is pending", async () => {
      expect(await store.listPending()).toEqual([]);
    });
  });

  describe("approve", () => {
    it("appends a hash-chained approve Approval and flips the draft to 'approved'", async () => {
      await store.save(draftInput());
      const approval = await store.approve("dr_store1", "human@example.com");

      expect(approval.decision).toBe("approve");
      expect(approval.draftId).toBe("dr_store1");
      expect(approval.actor).toBe("human@example.com");
      expect(approval.prevHash).toBe(GENESIS_HASH); // first approval in a fresh chain

      const persisted = await memory.getDraft("dr_store1");
      expect(persisted?.status).toBe("approved");
      expect(await memory.verifyAuditChain()).toBe(true);
    });

    it("chains a second approval off the first's hash", async () => {
      await store.save(draftInput({ id: "dr_x" }));
      await store.save(draftInput({ id: "dr_y" }));
      const a1 = await store.approve("dr_x", "human");
      const a2 = await store.approve("dr_y", "human");

      expect(a2.prevHash).toBe(a1.hash);
      expect(await memory.verifyAuditChain()).toBe(true);
    });

    it("throws a clear error for a draft id that doesn't exist", async () => {
      await expect(store.approve("no-such-draft", "human")).rejects.toThrow(/no draft with id/);
    });

    it("refuses to re-approve an already-dispatched draft (prevents a double-send)", async () => {
      await store.save(draftInput());
      // simulate dispatch.ts having already marked this draft dispatched, without going
      // through the store (DraftStore itself never sets this status — dispatch.ts does).
      await memory.setDraftStatus("dr_store1", "dispatched");

      await expect(store.approve("dr_store1", "human")).rejects.toThrow(
        /already dispatched/,
      );

      // no new Approval was appended by the refused attempt.
      const approvalRows = await memory.query<{ c: number | bigint }>(
        "SELECT COUNT(*) as c FROM approvals",
      );
      expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
      // status remains 'dispatched', not silently flipped back to 'approved'.
      expect((await memory.getDraft("dr_store1"))?.status).toBe("dispatched");
    });

    it("refuses to approve a draft that is currently 'dispatching' (send in flight)", async () => {
      await store.save(draftInput());
      // simulate dispatch.ts having atomically claimed this draft for an in-flight send.
      await memory.setDraftStatus("dr_store1", "dispatching");

      await expect(store.approve("dr_store1", "human")).rejects.toThrow(
        /currently being dispatched/,
      );

      // no new Approval was appended, and the status is NOT yanked back to 'approved' mid-send.
      const approvalRows = await memory.query<{ c: number | bigint }>(
        "SELECT COUNT(*) as c FROM approvals",
      );
      expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
      expect((await memory.getDraft("dr_store1"))?.status).toBe("dispatching");
    });
  });

  describe("reject", () => {
    it("appends a reject Approval and flips the draft to 'rejected'", async () => {
      await store.save(draftInput());
      const approval = await store.reject("dr_store1", "human@example.com");

      expect(approval.decision).toBe("reject");
      expect(approval.draftId).toBe("dr_store1");

      const persisted = await memory.getDraft("dr_store1");
      expect(persisted?.status).toBe("rejected");
      expect(await memory.verifyAuditChain()).toBe(true);
    });

    it("throws a clear error for a draft id that doesn't exist", async () => {
      await expect(store.reject("no-such-draft", "human")).rejects.toThrow(/no draft with id/);
    });

    it("refuses to reject an already-dispatched draft", async () => {
      await store.save(draftInput());
      await memory.setDraftStatus("dr_store1", "dispatched");

      await expect(store.reject("dr_store1", "human")).rejects.toThrow(/already dispatched/);
      expect((await memory.getDraft("dr_store1"))?.status).toBe("dispatched");
    });

    it("refuses to reject a draft that is currently 'dispatching' (send in flight)", async () => {
      await store.save(draftInput());
      await memory.setDraftStatus("dr_store1", "dispatching");

      await expect(store.reject("dr_store1", "human")).rejects.toThrow(/currently being dispatched/);
      expect((await memory.getDraft("dr_store1"))?.status).toBe("dispatching");
    });
  });

  describe("DRAFTS_DIR env default", () => {
    it("honors process.env.DRAFTS_DIR when no explicit draftsDir is passed to the constructor", async () => {
      const originalEnv = process.env.DRAFTS_DIR;
      const envDir = await mkdtemp(join(tmpdir(), "mstack-runtime-drafts-env-"));
      process.env.DRAFTS_DIR = envDir;
      const envMemory = await openMemory(":memory:");
      try {
        const defaultStore = new DraftStore(envMemory); // no draftsDir arg -> must read env
        const saved = await defaultStore.save(draftInput({ id: "dr_env" }));
        const written = await readFile(join(envDir, `${saved.id}.json`), "utf8");
        expect(JSON.parse(written).id).toBe("dr_env");
      } finally {
        if (originalEnv === undefined) delete process.env.DRAFTS_DIR;
        else process.env.DRAFTS_DIR = originalEnv;
        await envMemory.close();
        await rm(envDir, { recursive: true, force: true });
      }
    });
  });
});
