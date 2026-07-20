import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ActivateAccount, Decision, Draft } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "../draft-store.js";
import { runAccountActivation } from "./account-activation.js";
import type { ActivateFn } from "./account-activation.js";

const now = "2026-07-20T00:00:00.000Z";

const INPUT: ActivateAccount = ActivateAccount.parse({
  accountRef: { domain: "figma.com", name: "Figma" },
  mode: "copilot",
});

function cannedActivateFn(): ActivateFn {
  return async (input) => {
    const decision = Decision.parse({
      id: "dec_1",
      accountId: "acc_1",
      ts: now,
      score: 76,
      tier: "FIT",
      relevantSignals: [{ signalId: "sig_1", why: "evaluating collaboration infra" }],
      buyingCommittee: [],
      nextBestAction: { action: "email", channel: "email", targetMember: "VP Eng" },
      rationale: "high intent",
      byAgent: "gtm-router",
      mode: input.mode,
    });
    const draft = Draft.parse({
      id: "dr_outreach_1",
      kind: "outreach_email",
      refId: "acc_1",
      subject: "Following up",
      body: "Hi there, noticed a few things worth a quick chat.",
      createdBy: "copywriter",
      createdAt: now,
    });
    return { decision, draft };
  };
}

describe("runAccountActivation", () => {
  let memory: MemoryRepo;
  let draftsDir: string;
  let outboxDir: string;
  let draftStore: DraftStore;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    draftsDir = await mkdtemp(join(tmpdir(), "mstack-runtime-aa-drafts-"));
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-runtime-aa-outbox-"));
    draftStore = new DraftStore(memory, draftsDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(draftsDir, { recursive: true, force: true });
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("persists the Decision + a pending draft, and dispatches nothing", async () => {
    const result = await runAccountActivation(INPUT, {
      memory,
      draftStore,
      activateFn: cannedActivateFn(),
    });

    expect(result.decision.tier).toBe("FIT");
    const decisionRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM decisions WHERE account_id = $accountId",
      { accountId: "acc_1" },
    );
    expect(Number(decisionRows[0]?.c ?? -1)).toBe(1);

    expect(result.draft.status).toBe("pending");
    const persistedDraft = await memory.getDraft(result.draft.id);
    expect(persistedDraft?.status).toBe("pending");

    // dispatches NOTHING.
    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes",
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(0);
    expect(await readdir(outboxDir)).toEqual([]);

    const approvalRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM approvals",
    );
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
  });

  it("mode:'autopilot' still only ever produces a pending draft — this workflow never auto-approves", async () => {
    const autopilotInput = ActivateAccount.parse({ ...INPUT, mode: "autopilot" });
    const result = await runAccountActivation(autopilotInput, {
      memory,
      draftStore,
      activateFn: cannedActivateFn(),
    });

    expect(result.draft.status).toBe("pending");
    expect(result.decision.mode).toBe("autopilot"); // carried through for a future policy layer to read
    const approvalRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM approvals",
    );
    expect(Number(approvalRows[0]?.c ?? -1)).toBe(0);
  });
});
