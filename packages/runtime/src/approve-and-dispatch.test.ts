import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Draft } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "./draft-store.js";
import { LocalOutreachChannel } from "./channels.js";
import { approveAndDispatch, rejectDraft } from "./approve-and-dispatch.js";

const now = "2026-07-20T00:00:00.000Z";

function draftInput(overrides: Partial<Draft> = {}): Draft {
  return Draft.parse({
    id: "dr_full1",
    kind: "outreach_email",
    refId: "acc_1",
    subject: "hello",
    body: "hi there",
    createdBy: "test",
    createdAt: now,
    ...overrides,
  });
}

describe("approveAndDispatch — the human-gated completion of the draft-first loop", () => {
  let memory: MemoryRepo;
  let draftsDir: string;
  let outboxDir: string;
  let draftStore: DraftStore;
  let channel: LocalOutreachChannel;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-runtime-e2e-drafts-"));
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-runtime-e2e-outbox-"));
    draftStore = new DraftStore(memory, draftsDir);
    channel = new LocalOutreachChannel(outboxDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("end-to-end: save (pending) -> approveAndDispatch -> dispatched + Outcome + outbox file + valid audit chain", async () => {
    const saved = await draftStore.save(draftInput());
    expect(saved.status).toBe("pending");

    const outcome = await approveAndDispatch(saved.id, "human@example.com", channel, {
      memory,
      draftStore,
    });

    expect(outcome.result).toBe("sent");
    expect(outcome.refType).toBe("draft");
    expect(outcome.refId).toBe(saved.id);

    const persisted = await memory.getDraft(saved.id);
    expect(persisted?.status).toBe("dispatched");

    // `result` lives in the JSON `data` column (not an indexed column); the returned
    // outcome's result === "sent" is already asserted above. Here just confirm exactly
    // one Outcome row was persisted for this draft (queried by the indexed ref_id).
    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: saved.id },
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(1);

    const outboxFile = join(outboxDir, `${saved.id}.json`);
    const written = JSON.parse(await readFile(outboxFile, "utf8")) as { draft: { id: string } };
    expect(written.draft.id).toBe(saved.id);

    expect(await memory.verifyAuditChain()).toBe(true);
  });

  it("throws a clear error when approving a draft id that does not exist (never reaches the channel)", async () => {
    let dispatchCalled = false;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        dispatchCalled = true;
        throw new Error("must not be called");
      },
    };

    await expect(
      approveAndDispatch("no-such-draft", "human", spyChannel, { memory, draftStore }),
    ).rejects.toThrow(/no draft with id/);
    expect(dispatchCalled).toBe(false);
  });

  it("rejectDraft: moves the draft to 'rejected', records a reject Approval, dispatches nothing", async () => {
    const saved = await draftStore.save(draftInput({ id: "dr_reject1" }));

    const approval = await rejectDraft(saved.id, "human@example.com", { draftStore });

    expect(approval.decision).toBe("reject");
    expect(approval.draftId).toBe(saved.id);
    const persisted = await memory.getDraft(saved.id);
    expect(persisted?.status).toBe("rejected");

    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes",
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(0);
    expect(await memory.verifyAuditChain()).toBe(true);
  });
});
