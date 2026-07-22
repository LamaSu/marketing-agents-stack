import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Draft } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "./draft-store.js";
import { LocalOutreachChannel } from "./channels.js";
import { approveAndDispatch, rejectDraft } from "./approve-and-dispatch.js";
import { noopApproverNotifier, humanLayerNotifier, defaultFormatMessage } from "./approver-notifier.js";
import type { ApproverNotifier, HumanLayerLike, HumanLayerContactSpec } from "./approver-notifier.js";

const now = "2026-07-20T00:00:00.000Z";

function draftInput(overrides: Partial<Draft> = {}): Draft {
  return Draft.parse({
    id: "dr_notify1",
    kind: "outreach_email",
    refId: "acc_1",
    subject: "hello",
    body: "hi there",
    createdBy: "test",
    createdAt: now,
    ...overrides,
  });
}

/** A fake `HumanLayerLike` that records every notification it is handed. Note its ONLY
 *  method is `createHumanContact` — a fake cannot approve or dispatch, which is the point:
 *  the seam gives a notifier no capability to do either. */
function makeFakeClient(): { client: HumanLayerLike; calls: HumanLayerContactSpec[] } {
  const calls: HumanLayerContactSpec[] = [];
  const client: HumanLayerLike = {
    async createHumanContact(spec: HumanLayerContactSpec): Promise<unknown> {
      calls.push(spec);
      return { id: "hc_fake" };
    },
  };
  return { client, calls };
}

async function countRows(memory: MemoryRepo, table: "approvals" | "outcomes"): Promise<number> {
  // `table` is a fixed literal union (never external input) — the template is safe.
  const rows = await memory.query<{ c: number | bigint }>(`SELECT COUNT(*) as c FROM ${table}`);
  return Number(rows[0]?.c ?? -1);
}

describe("noopApproverNotifier — the offline default", () => {
  it("does nothing and resolves to undefined", async () => {
    await expect(noopApproverNotifier.notifyPending(draftInput())).resolves.toBeUndefined();
  });
});

describe("humanLayerNotifier — opt-in, offline via an injected client", () => {
  it("calls the injected client's createHumanContact with the default formatted message", async () => {
    const { client, calls } = makeFakeClient();
    const draft = draftInput({ id: "dr_x", subject: "Q3 launch" });

    await humanLayerNotifier({ client }).notifyPending(draft);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.msg).toContain("dr_x");
    expect(calls[0]?.msg).toContain("Q3 launch");
    expect(calls[0]?.msg).toBe(defaultFormatMessage(draft));
  });

  it("uses a custom formatMessage and passes contactChannel through to the spec", async () => {
    const { client, calls } = makeFakeClient();
    const notifier = humanLayerNotifier({
      client,
      formatMessage: (d) => `PENDING ${d.id}`,
      contactChannel: { slack: "#approvals" },
    });

    await notifier.notifyPending(draftInput({ id: "dr_y" }));

    expect(calls[0]?.msg).toBe("PENDING dr_y");
    expect(calls[0]?.channel).toEqual({ slack: "#approvals" });
  });

  it("never puts the draft body in the notification (it points at the portal; it is not the draft)", async () => {
    const { client, calls } = makeFakeClient();
    await humanLayerNotifier({ client }).notifyPending(
      draftInput({ id: "dr_z", body: "SECRET-BODY-CONTENT" }),
    );
    expect(calls[0]?.msg).not.toContain("SECRET-BODY-CONTENT");
  });

  it("degrades to a no-op (resolves, never throws) when the client's call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notifier = humanLayerNotifier({
      client: {
        async createHumanContact(): Promise<unknown> {
          throw new Error("slack down");
        },
      },
    });

    await expect(notifier.notifyPending(draftInput())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades to a no-op when the client cannot be loaded, and loads at most once (memoized)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let loads = 0;
    const notifier = humanLayerNotifier({
      loadClient: async () => {
        loads++;
        throw new Error("no SDK installed");
      },
    });

    await expect(notifier.notifyPending(draftInput())).resolves.toBeUndefined();
    await expect(notifier.notifyPending(draftInput())).resolves.toBeUndefined();
    expect(loads).toBe(1); // the failed load is not re-attempted on every notify
    warn.mockRestore();
  });

  it("lazily loads via loadClient when no client is injected, and reuses it across notifies", async () => {
    const { client, calls } = makeFakeClient();
    let loads = 0;
    const notifier = humanLayerNotifier({
      loadClient: async () => {
        loads++;
        return client;
      },
    });

    await notifier.notifyPending(draftInput({ id: "dr_a" }));
    await notifier.notifyPending(draftInput({ id: "dr_b" }));

    expect(loads).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe("GUARDRAIL: HumanLayer is the DOORBELL, not the LEDGER — notifier wired into DraftStore", () => {
  let memory: MemoryRepo;
  let draftsDir: string;
  let outboxDir: string;
  let channel: LocalOutreachChannel;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-approver-drafts-"));
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-approver-outbox-"));
    channel = new LocalOutreachChannel(outboxDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("save() rings the doorbell but writes NO Approval and causes NO send; only approveAndDispatch does", async () => {
    const { client, calls } = makeFakeClient();
    const draftStore = new DraftStore(memory, draftsDir, humanLayerNotifier({ client }));

    // save() rings the doorbell for THIS draft...
    const saved = await draftStore.save(draftInput());
    expect(saved.status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.msg).toContain(saved.id);

    // ...but the doorbell is not the ledger: no Approval, no Outcome, no outbox file, still pending.
    expect(await countRows(memory, "approvals")).toBe(0);
    expect(await countRows(memory, "outcomes")).toBe(0);
    expect(await readdir(outboxDir)).toHaveLength(0);
    expect((await memory.getDraft(saved.id))?.status).toBe("pending");

    // the ONLY path to a send is the real gate: DraftStore#approve (writes the signed,
    // hash-chained Approval) -> dispatchDraft. The notifier played no part in it.
    const outcome = await approveAndDispatch(saved.id, "human@example.com", channel, {
      memory,
      draftStore,
    });
    expect(outcome.result).toBe("sent");
    expect(await countRows(memory, "approvals")).toBe(1); // the Approval came from DraftStore#approve
    expect(await memory.verifyAuditChain()).toBe(true); // ...and it is hash-chained
    expect((await memory.getDraft(saved.id))?.status).toBe("dispatched");
    expect(await readdir(outboxDir)).toHaveLength(1); // the one send happened via dispatch

    // approving did NOT ring the doorbell again — save() rings it, approve()/reject() do not.
    expect(calls).toHaveLength(1);
  });

  it("a rejected draft still notifies on save, yet the notifier cannot turn a reject into a send", async () => {
    const { client, calls } = makeFakeClient();
    const draftStore = new DraftStore(memory, draftsDir, humanLayerNotifier({ client }));

    const saved = await draftStore.save(draftInput({ id: "dr_notify_reject" }));
    expect(calls).toHaveLength(1); // doorbell rang on save

    const approval = await rejectDraft(saved.id, "human@example.com", { draftStore });
    expect(approval.decision).toBe("reject");
    expect((await memory.getDraft(saved.id))?.status).toBe("rejected");
    expect(await countRows(memory, "outcomes")).toBe(0); // nothing sent
    expect(await readdir(outboxDir)).toHaveLength(0);
    expect(await memory.verifyAuditChain()).toBe(true);
  });

  it("a THROWING notifier cannot corrupt save() or the gate — draft stays safely pending, chain intact, still approvable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: ApproverNotifier = {
      async notifyPending(): Promise<void> {
        throw new Error("doorbell exploded");
      },
    };
    const draftStore = new DraftStore(memory, draftsDir, throwing);

    // save() must NOT reject just because the doorbell threw.
    const saved = await draftStore.save(draftInput({ id: "dr_notify_throw" }));
    expect(saved.status).toBe("pending");
    expect(await memory.getDraft(saved.id)).toBeTruthy(); // persisted despite the throw
    expect(await countRows(memory, "outcomes")).toBe(0);
    expect(await memory.verifyAuditChain()).toBe(true);
    expect(warn).toHaveBeenCalled(); // the failure was logged, not surfaced into save()

    // the gate still works normally afterward — the failed doorbell left no damage.
    const outcome = await approveAndDispatch(saved.id, "human", channel, { memory, draftStore });
    expect(outcome.result).toBe("sent");
    expect(await memory.verifyAuditChain()).toBe(true);
    warn.mockRestore();
  });

  it("the DEFAULT DraftStore (no notifier arg) behaves exactly as before — offline unchanged", async () => {
    const draftStore = new DraftStore(memory, draftsDir); // 2-arg construction, as every existing caller uses

    const saved = await draftStore.save(draftInput({ id: "dr_notify_default" }));
    expect(saved.status).toBe("pending");
    expect(await countRows(memory, "approvals")).toBe(0);

    const outcome = await approveAndDispatch(saved.id, "human", channel, { memory, draftStore });
    expect(outcome.result).toBe("sent");
    expect(await memory.verifyAuditChain()).toBe(true);
  });
});
