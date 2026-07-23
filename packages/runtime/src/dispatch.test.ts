import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Approval, Draft, GENESIS_HASH, Outcome, newId } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { dispatchDraft, assertApproved } from "./dispatch.js";
import { draftContentHash } from "./content-hash.js";
import { LocalOutreachChannel } from "./channels.js";
import { DraftStore } from "./draft-store.js";

const now = "2026-07-20T00:00:00.000Z";

function pendingDraft(overrides: Partial<Draft> = {}): Draft {
  return Draft.parse({
    id: "dr_test1",
    kind: "outreach_email",
    refId: "acc_1",
    subject: "hello",
    body: "hi there",
    createdBy: "test",
    createdAt: now,
    ...overrides,
  });
}

function approveApproval(overrides: Partial<Approval> = {}): Approval {
  return Approval.parse({
    id: "appr_1",
    draftId: "dr_test1",
    decision: "approve",
    actor: "human",
    ts: now,
    prevHash: GENESIS_HASH,
    hash: "a".repeat(64),
    ...overrides,
  });
}

describe("dispatchDraft — guardrail #2: THE ONLY send path", () => {
  let memory: MemoryRepo;
  let outboxDir: string;
  let channel: OutreachChannel;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-runtime-dispatch-"));
    channel = new LocalOutreachChannel(outboxDir);
  });

  afterEach(async () => {
    await memory.close();
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("throws when no Approval is supplied", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    // The runtime guard (assertApproved) is what actually catches this even though the
    // compile-time signature requires an Approval -- a caller working from `unknown` input
    // (e.g. deserialized JSON) can still reach this at runtime, which is exactly the case
    // the guard exists for.
    const missingApproval = undefined as unknown as Approval;

    await expect(dispatchDraft(draft, missingApproval, channel, memory)).rejects.toThrow(
      /no Approval supplied/,
    );
  });

  it("throws when the Approval's draftId does not match the draft", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    const approval = approveApproval({ draftId: "some-other-draft" });

    await expect(dispatchDraft(draft, approval, channel, memory)).rejects.toThrow(
      /is for draft "some-other-draft", not "dr_test1"/,
    );
  });

  it("throws when the Approval's decision is not 'approve'", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    const approval = approveApproval({ decision: "reject" });

    await expect(dispatchDraft(draft, approval, channel, memory)).rejects.toThrow(
      /decision is "reject", not "approve"/,
    );
  });

  it("throws when the draft's own status is not 'approved' (e.g. still 'pending')", async () => {
    const draft = pendingDraft({ status: "pending" });
    await memory.putDraft(draft);
    const approval = approveApproval();

    await expect(dispatchDraft(draft, approval, channel, memory)).rejects.toThrow(
      /has status "pending", not "approved"/,
    );
  });

  it("none of the throwing cases touch the channel or memory (no outcome, draft status untouched)", async () => {
    const draft = pendingDraft({ status: "pending" });
    await memory.putDraft(draft);
    const approval = approveApproval();
    let dispatchCalls = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        dispatchCalls++;
        throw new Error("should never be called");
      },
    };

    await expect(dispatchDraft(draft, approval, spyChannel, memory)).rejects.toThrow();
    expect(dispatchCalls).toBe(0);

    const stillPending = await memory.getDraft(draft.id);
    expect(stillPending?.status).toBe("pending");
    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes",
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(0);
  });

  it("on a valid approved draft + matching Approval: dispatches, marks the draft dispatched, and persists an Outcome", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    // Real, persisted, hash-chained approval -- not just a well-shaped object. This is what
    // `assertDispatchable` now requires: an Approval that actually went through
    // `memory.appendApproval` (mirroring what `DraftStore#approve` does in the real flow).
    const approval = await memory.appendApproval({
      id: "appr_1",
      draftId: draft.id,
      decision: "approve",
      actor: "human",
      contentHash: draftContentHash(draft),
      ts: now,
    });

    const outcome = await dispatchDraft(draft, approval, channel, memory);

    expect(outcome.refType).toBe("draft");
    expect(outcome.refId).toBe(draft.id);
    expect(outcome.result).toBe("sent");

    const persistedDraft = await memory.getDraft(draft.id);
    expect(persistedDraft?.status).toBe("dispatched");

    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: draft.id },
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(1);

    // the channel really did write the outbox record (proves the channel was actually called,
    // not just that memory bookkeeping happened).
    const outboxFile = join(outboxDir, `${draft.id}.json`);
    const written = JSON.parse(await readFile(outboxFile, "utf8")) as { draft: { id: string } };
    expect(written.draft.id).toBe(draft.id);
  });

  it("HARDENING: refuses a forged Approval object that was never persisted (never went through memory.appendApproval), even though it is structurally well-formed and would pass assertApproved", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    // Internally consistent with `draft` (matching draftId, decision:"approve") -- exactly the
    // shape a forged/deserialized-from-untrusted-input Approval would have. It was never written
    // via `memory.appendApproval`, so it has no row in the `approvals` audit log.
    const forgedApproval = approveApproval();
    let dispatchCalls = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        dispatchCalls++;
        throw new Error("should never be called");
      },
    };

    await expect(dispatchDraft(draft, forgedApproval, spyChannel, memory)).rejects.toThrow(
      /Approval "appr_1" is not in the system of record/,
    );
    expect(dispatchCalls).toBe(0);

    // the draft must be untouched -- a refused dispatch must not have any side effect.
    const stillApproved = await memory.getDraft(draft.id);
    expect(stillApproved?.status).toBe("approved");
  });

  it("HARDENING: refuses a second dispatchDraft of an already-dispatched draft (closes the sequential double-send / TOCTOU window)", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    const approval = await memory.appendApproval({
      id: "appr_double",
      draftId: draft.id,
      decision: "approve",
      actor: "human",
      contentHash: draftContentHash(draft),
      ts: now,
    });

    // first dispatch succeeds normally.
    const firstOutcome = await dispatchDraft(draft, approval, channel, memory);
    expect(firstOutcome.result).toBe("sent");
    const afterFirst = await memory.getDraft(draft.id);
    expect(afterFirst?.status).toBe("dispatched");

    // second dispatch reuses the SAME (now-stale) `draft`/`approval` objects the caller still
    // holds -- both still look perfectly valid on their face. The persisted-status recheck must
    // refuse it anyway.
    let secondDispatchCalls = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        secondDispatchCalls++;
        throw new Error("should never be called");
      },
    };

    await expect(dispatchDraft(draft, approval, spyChannel, memory)).rejects.toThrow(
      /already dispatched/,
    );
    expect(secondDispatchCalls).toBe(0);

    // only ONE Outcome row must exist for this draft -- the refused second call must not have
    // produced a second "sent" record.
    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: draft.id },
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(1);
  });

  it("HARDENING (#2): refuses a draft whose content changed after approval (content-hash binding)", async () => {
    const cbindDir = await mkdtemp(join(tmpdir(), "mstack-runtime-cbind-"));
    const store = new DraftStore(memory, cbindDir);
    let sends = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        sends++;
        throw new Error("should never be called");
      },
    };
    try {
      const saved = await store.save(pendingDraft({ id: "dr_cbind", body: "original body" }));
      const approval = await store.approve(saved.id, "human"); // pins contentHash over "original body"
      expect(approval.contentHash).toBeDefined();

      // Swap the approved draft's content out from under the approval (status stays 'approved').
      const approved = await memory.getDraft(saved.id);
      if (!approved) throw new Error("precondition: approved draft should be persisted");
      await memory.putDraft({ ...approved, body: "SWAPPED body no human approved" });

      await expect(dispatchDraft(saved, approval, spyChannel, memory)).rejects.toThrow(
        /content has changed since it was approved/,
      );
      expect(sends).toBe(0);
      // the refused send must not have marked the draft dispatched.
      expect((await memory.getDraft(saved.id))?.status).toBe("approved");
    } finally {
      await rm(cbindDir, { recursive: true, force: true });
    }
  });

  it("REGRESSION (#1): a channel failure reverts the draft to 'approved' (no Outcome), and a retry CAN send", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    const approval = await memory.appendApproval({
      id: "appr_retry",
      draftId: draft.id,
      decision: "approve",
      actor: "human",
      contentHash: draftContentHash(draft),
      ts: now,
    });

    // A channel that THROWS on the first call (transient failure) and succeeds on the second.
    let sends = 0;
    const flakyThenOk: OutreachChannel = {
      name: "flaky",
      kind: "email",
      dispatch: async (d, a) => {
        sends++;
        if (sends === 1) throw new Error("transient channel failure");
        assertApproved(d, a); // mirror a real channel's defensive re-check on the retry
        return Outcome.parse({ id: newId("out"), refType: "draft", refId: d.id, result: "sent", ts: now });
      },
    };

    // First attempt: the claim wins, the channel is called (sends -> 1) and throws. The draft must
    // REVERT to 'approved' (NOT stick at 'dispatched'), and NO Outcome may be recorded — nothing
    // was actually sent. This is the regression: the old code left it falsely 'dispatched' here.
    await expect(dispatchDraft(draft, approval, flakyThenOk, memory)).rejects.toThrow(
      /transient channel failure/,
    );
    expect(sends).toBe(1);
    expect((await memory.getDraft(draft.id))?.status).toBe("approved"); // reverted => retryable
    const afterFail = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: draft.id },
    );
    expect(Number(afterFail[0]?.c ?? -1)).toBe(0); // no Outcome — the send did not happen

    // A legitimate RETRY with the SAME (still-valid) approval now succeeds: the draft is 'approved'
    // again, the claim wins, the channel sends, and exactly one Outcome is recorded.
    const outcome = await dispatchDraft(draft, approval, flakyThenOk, memory);
    expect(outcome.result).toBe("sent");
    expect(sends).toBe(2);
    expect((await memory.getDraft(draft.id))?.status).toBe("dispatched");
    const afterRetry = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: draft.id },
    );
    expect(Number(afterRetry[0]?.c ?? -1)).toBe(1);
  });

  it("REGRESSION (#1): a REAL concurrent race (Promise.all of two dispatchDraft) sends exactly once", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    const approval = await memory.appendApproval({
      id: "appr_race",
      draftId: draft.id,
      decision: "approve",
      actor: "human",
      contentHash: draftContentHash(draft),
      ts: now,
    });

    // Count actual channel sends across BOTH concurrent callers. Only the caller that wins the
    // atomic claim ever reaches the channel; the loser is refused before it.
    let sends = 0;
    const countingChannel: OutreachChannel = {
      name: "counting",
      kind: "email",
      dispatch: async (d, a) => {
        sends++;
        assertApproved(d, a);
        return Outcome.parse({ id: newId("out"), refType: "draft", refId: d.id, result: "sent", ts: now });
      },
    };

    // Genuinely concurrent (Promise.all, not two sequential awaits — the case the re-audit flagged
    // the old sequential test as NOT covering). Exactly one must win the claim and send; the other
    // must be refused WITHOUT calling the channel.
    const results = await Promise.allSettled([
      dispatchDraft(draft, approval, countingChannel, memory),
      dispatchDraft(draft, approval, countingChannel, memory),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(sends).toBe(1); // the channel was called exactly once — NO double-send

    const outcomeRows = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM outcomes WHERE ref_id = $refId",
      { refId: draft.id },
    );
    expect(Number(outcomeRows[0]?.c ?? -1)).toBe(1); // exactly one Outcome
    expect((await memory.getDraft(draft.id))?.status).toBe("dispatched");
  });

  it("HARDENING (#2): refuses to dispatch when the recorded Approval has NO content binding", async () => {
    const draft = pendingDraft({ status: "approved" });
    await memory.putDraft(draft);
    // A real, hash-chained approval — but with NO contentHash (an old-style / unbound approval).
    const approval = await memory.appendApproval({
      id: "appr_nobind",
      draftId: draft.id,
      decision: "approve",
      actor: "human",
      ts: now,
    });
    expect(approval.contentHash).toBeUndefined();

    let sends = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        sends++;
        throw new Error("should never be called");
      },
    };

    await expect(dispatchDraft(draft, approval, spyChannel, memory)).rejects.toThrow(
      /carries no content binding/,
    );
    expect(sends).toBe(0);
    // refused with no side effect — the draft stays 'approved'.
    expect((await memory.getDraft(draft.id))?.status).toBe("approved");
  });

  it("HARDENING (#2): mutating ANY dispatch-relevant draft field after approval is refused (not just body)", async () => {
    const cbindDir = await mkdtemp(join(tmpdir(), "mstack-runtime-cbind2-"));
    const store = new DraftStore(memory, cbindDir);
    let sends = 0;
    const spyChannel: OutreachChannel = {
      name: "spy",
      kind: "email",
      dispatch: async () => {
        sends++;
        throw new Error("should never be called");
      },
    };
    try {
      const saved = await store.save(
        pendingDraft({ id: "dr_cbind2", subject: "orig subject", body: "orig body", createdBy: "orig-author" }),
      );
      const approval = await store.approve(saved.id, "human");
      expect(approval.contentHash).toBeDefined();

      // Mutate a field the OLD 5-field hash did NOT cover — `createdBy` — leaving subject/body/etc.
      // intact. The broadened binding (whole Draft minus status) must still catch it; a custom
      // channel `mapDraft` could read `createdBy`, so it is dispatch-relevant.
      const approved = await memory.getDraft(saved.id);
      if (!approved) throw new Error("precondition: approved draft should be persisted");
      await memory.putDraft({ ...approved, createdBy: "attacker-swapped-author" });

      await expect(dispatchDraft(saved, approval, spyChannel, memory)).rejects.toThrow(
        /content has changed since it was approved/,
      );
      expect(sends).toBe(0);
      expect((await memory.getDraft(saved.id))?.status).toBe("approved");
    } finally {
      await rm(cbindDir, { recursive: true, force: true });
    }
  });
});

describe("assertApproved", () => {
  it("narrows / returns normally for a valid approved draft + matching approve Approval", () => {
    const draft = pendingDraft({ status: "approved" });
    const approval = approveApproval();
    expect(() => assertApproved(draft, approval)).not.toThrow();
  });
});

describe("GUARDRAIL: exactly one `*.dispatch(` call site in this package's production source", () => {
  // dispatch.ts is documented as THE ONLY function allowed to call `OutreachChannel.dispatch`.
  // This test grep-scans every non-test .ts file under src/ (recursively, including
  // workflows/) for an actual CALL of a `.dispatch(...)` method -- i.e. `<identifier>.dispatch(`
  // -- and asserts there is exactly one, and that it lives in dispatch.ts. This pattern
  // deliberately does NOT match a `dispatch(...)` METHOD DEFINITION (e.g. `async dispatch(draft,
  // approval) {` in channels.ts), because a definition has no `<identifier>.` immediately
  // before the word "dispatch" -- only a call site does. Test files are excluded from the scan
  // on purpose: channels.test.ts legitimately calls a channel's `dispatch()` directly to test
  // the channel's own defensive re-assertion, which is not a violation of the guardrail (the
  // guardrail is about the PRODUCTION send path, not about what tests are allowed to exercise
  // directly).
  const CALL_SITE_PATTERN = /\w+\.dispatch\s*\(/g;

  function collectProductionSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectProductionSourceFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("has exactly one `<expr>.dispatch(` call, and it is in dispatch.ts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const files = collectProductionSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0); // sanity: the scan actually found files

    const hits: Array<{ file: string; count: number }> = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const matches = content.match(CALL_SITE_PATTERN);
      if (matches && matches.length > 0) {
        hits.push({ file, count: matches.length });
      }
    }

    const totalCallSites = hits.reduce((sum, h) => sum + h.count, 0);
    expect(totalCallSites).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file.replace(/\\/g, "/")).toMatch(/\/dispatch\.ts$/);
  });
});
