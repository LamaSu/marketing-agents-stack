/**
 * executor.test.ts — the durable-execution seam (research/10-sota-integration-design.md §2.7),
 * exercised fully OFFLINE. There is no Hatchet server and no Postgres in CI, so:
 *   - `DirectExecutor` runs both workflows exactly as today (pending drafts, nothing dispatched);
 *   - `HatchetExecutor` / `registerRuntimeWorkflows` are exercised against a MOCK Hatchet client
 *     (assert the three workflows register and that each task body IS the step function);
 *   - idempotency is asserted directly — a re-delivered `approveAndDispatch` / `dispatchDraft` on
 *     an already-`dispatched` draft is refused — which is what makes Hatchet's at-least-once
 *     retries and crash-resume safe. The real crash-resume is validated only when a deployer runs
 *     Hatchet + Postgres (documented in README.md).
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivateAccount, Decision, Draft, Review, ReviewRequest } from "@mstack/core";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";

import { DraftStore } from "./draft-store.js";
import { LocalOutreachChannel } from "./channels.js";
import { dispatchDraft } from "./dispatch.js";
import { approveAndDispatch } from "./approve-and-dispatch.js";
import { runContentReview } from "./workflows/content-review.js";
import type { ReviewFn } from "./workflows/content-review.js";
import { runAccountActivation } from "./workflows/account-activation.js";
import type { ActivateFn } from "./workflows/account-activation.js";
import { DirectExecutor } from "./executor.js";
import type { Executor } from "./executor.js";
import {
  HatchetExecutor,
  RUNTIME_WORKFLOW_NAMES,
  registerRuntimeWorkflows,
} from "./hatchet-executor.js";
import type {
  HatchetLike,
  HatchetTaskConfig,
  HatchetTaskHandle,
  HatchetWorkerHandle,
  HatchetWorkerOpts,
} from "./hatchet-executor.js";

const now = "2026-07-20T00:00:00.000Z";

/* ────────────────────────────── fixtures ────────────────────────────── */

function need<T>(value: T | null | undefined, msg: string): T {
  if (value == null) throw new Error(msg);
  return value;
}

const REQUEST: ReviewRequest = ReviewRequest.parse({
  partnerId: "partner_1",
  partnerTier: "Select",
  contentTitle: "Q3 case study",
  contentType: "case_study",
  content: "We guarantee 10x ROI in 30 days.",
});

const INPUT: ActivateAccount = ActivateAccount.parse({
  accountRef: { domain: "figma.com", name: "Figma" },
  mode: "copilot",
});

function cannedReviewFn(): ReviewFn {
  return async (req) => {
    const review = Review.parse({
      id: "rev_1",
      assetId: "asset_1",
      partnerId: req.partnerId,
      partnerTier: req.partnerTier,
      score: 2,
      changesCount: 1,
      verdict: "RETURNED",
      createdAt: now,
      findings: [
        {
          id: "f1",
          reviewId: "rev_1",
          category: "guaranteed_outcome",
          required: true,
          quote: "guarantee 10x ROI",
          recommendedChange: "remove the guarantee",
          supportingPassageId: null,
          detectedBy: "deterministic",
          severity: "high",
        },
      ],
    });
    const partnerEmail = Draft.parse({
      id: "dr_email_1",
      kind: "partner_email",
      refId: "rev_1",
      subject: "Content review — RETURNED",
      body: "Please address the required change.",
      createdBy: "reviewer",
      createdAt: now,
    });
    const reviewExport = Draft.parse({
      id: "dr_export_1",
      kind: "review_export",
      refId: "rev_1",
      subject: "Annotated review",
      body: "Findings: guaranteed_outcome...",
      channel: "export",
      createdBy: "reviewer",
      createdAt: now,
    });
    return { review, partnerEmail, reviewExport };
  };
}

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

/* ─────────────────────────── mock Hatchet client ─────────────────────── */

interface RecordedTask {
  name: string;
  retries?: number;
  fn: (input: unknown, ctx?: unknown) => Promise<unknown>;
  runInputs: unknown[];
}

interface RecordedWorker {
  name: string;
  workflowCount: number;
  started: boolean;
}

interface MockHatchet {
  client: HatchetLike;
  tasks: RecordedTask[];
  workers: RecordedWorker[];
  byName(name: string): RecordedTask | undefined;
}

/**
 * A `HatchetLike` that records every `task(...)` / `worker(...)` call. Its task handle's `.run()`
 * invokes the recorded body `runTimes` times (default 1) — set `runTimes: 2` to simulate
 * Hatchet re-delivering a task (at-least-once), which is how the idempotency guard is exercised.
 */
function makeMockHatchet(mockOpts: { runTimes?: number } = {}): MockHatchet {
  const runTimes = mockOpts.runTimes ?? 1;
  const tasks: RecordedTask[] = [];
  const workers: RecordedWorker[] = [];

  const client: HatchetLike = {
    task<I, O>(config: HatchetTaskConfig<I, O>): HatchetTaskHandle<I, O> {
      const rec: RecordedTask = {
        name: config.name,
        retries: config.retries,
        fn: config.fn as unknown as RecordedTask["fn"],
        runInputs: [],
      };
      tasks.push(rec);
      return {
        run: async (input: I): Promise<O> => {
          rec.runInputs.push(input);
          let result: unknown = undefined;
          for (let i = 0; i < runTimes; i++) {
            result = await rec.fn(input as unknown);
          }
          return result as O;
        },
      };
    },
    async worker(name: string, opts: HatchetWorkerOpts): Promise<HatchetWorkerHandle> {
      const w: RecordedWorker = { name, workflowCount: opts.workflows.length, started: false };
      workers.push(w);
      return {
        start: async () => {
          w.started = true;
        },
      };
    },
  };

  return { client, tasks, workers, byName: (name) => tasks.find((t) => t.name === name) };
}

/* ──────────────────────────── shared harness ─────────────────────────── */

let memory: MemoryRepo;
let draftsDir: string;
let outboxDir: string;
let draftStore: DraftStore;

async function countRows(table: "outcomes" | "approvals", refId?: string): Promise<number> {
  const sql = refId
    ? `SELECT COUNT(*) as c FROM ${table} WHERE ref_id = $refId`
    : `SELECT COUNT(*) as c FROM ${table}`;
  const rows = await memory.query<{ c: number | bigint }>(sql, refId ? { refId } : undefined);
  return Number(rows[0]?.c ?? -1);
}

async function outboxJsonCount(): Promise<number> {
  const files = await readdir(outboxDir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".json")).length;
}

function savePendingDraft(id: string): Promise<Draft> {
  return draftStore.save(
    Draft.parse({
      id,
      kind: "outreach_email",
      refId: "acc_1",
      subject: "Following up",
      body: "hi there",
      createdBy: "test",
      createdAt: now,
    }),
  );
}

function fullDeps(channel: LocalOutreachChannel) {
  return {
    memory,
    draftStore,
    reviewFn: cannedReviewFn(),
    activateFn: cannedActivateFn(),
    channel,
  };
}

beforeEach(async () => {
  memory = await openMemory(":memory:");
  draftsDir = await mkdtemp(join(tmpdir(), "mstack-exec-drafts-"));
  outboxDir = await mkdtemp(join(tmpdir(), "mstack-exec-outbox-"));
  draftStore = new DraftStore(memory, draftsDir);
});

afterEach(async () => {
  await memory.close();
  await rm(draftsDir, { recursive: true, force: true });
  await rm(outboxDir, { recursive: true, force: true });
});

/* ───────────────────── 1. DirectExecutor (offline default) ───────────── */

describe("DirectExecutor — the offline default that mstack demo runs on", () => {
  it("runs content-review + account-activation in-process: pending drafts, nothing dispatched", async () => {
    const executor = new DirectExecutor();

    const cr = await executor.run(RUNTIME_WORKFLOW_NAMES.contentReview, REQUEST, (r) =>
      runContentReview(r, { memory, draftStore, reviewFn: cannedReviewFn() }),
    );
    expect(cr.drafts.partnerEmail.status).toBe("pending");
    expect(cr.drafts.reviewExport.status).toBe("pending");

    const aa = await executor.run(RUNTIME_WORKFLOW_NAMES.accountActivation, INPUT, (i) =>
      runAccountActivation(i, { memory, draftStore, activateFn: cannedActivateFn() }),
    );
    expect(aa.draft.status).toBe("pending");

    // nothing dispatched: no Outcome rows, no Approval rows, empty outbox.
    expect(await countRows("outcomes")).toBe(0);
    expect(await countRows("approvals")).toBe(0);
    expect(await outboxJsonCount()).toBe(0);
  });

  it("run is a transparent pass-through: returns exactly the step's result", async () => {
    const executor: Executor = new DirectExecutor();
    const out = await executor.run("echo", { n: 21 }, async (i) => ({ doubled: i.n * 2 }));
    expect(out).toEqual({ doubled: 42 });
  });
});

/* ─────────── 2. registerRuntimeWorkflows registers the 3 as Hatchet tasks ────────── */

describe("registerRuntimeWorkflows — the three workflows register as Hatchet tasks (mock client)", () => {
  it("declares exactly three tasks, named content-review / account-activation / approve-and-dispatch", () => {
    const mock = makeMockHatchet();
    registerRuntimeWorkflows(mock.client, fullDeps(new LocalOutreachChannel(outboxDir)));

    expect(mock.tasks.map((t) => t.name).sort()).toEqual([
      "account-activation",
      "approve-and-dispatch",
      "content-review",
    ]);
  });

  it("content-review's task body IS runContentReview (persists a Review + 2 pending drafts, sends nothing)", async () => {
    const mock = makeMockHatchet();
    registerRuntimeWorkflows(mock.client, fullDeps(new LocalOutreachChannel(outboxDir)));

    const task = need(mock.byName(RUNTIME_WORKFLOW_NAMES.contentReview), "content-review not registered");
    const result = (await task.fn(REQUEST)) as {
      drafts: { partnerEmail: { status: string }; reviewExport: { status: string } };
    };

    expect(result.drafts.partnerEmail.status).toBe("pending");
    expect(result.drafts.reviewExport.status).toBe("pending");
    const reviews = await memory.listReviews({ partnerId: "partner_1" });
    expect(reviews.map((r) => r.id)).toContain("rev_1");
    expect(await countRows("outcomes")).toBe(0);
  });

  it("account-activation's task body IS runAccountActivation (persists a Decision + 1 pending draft)", async () => {
    const mock = makeMockHatchet();
    registerRuntimeWorkflows(mock.client, fullDeps(new LocalOutreachChannel(outboxDir)));

    const task = need(
      mock.byName(RUNTIME_WORKFLOW_NAMES.accountActivation),
      "account-activation not registered",
    );
    const result = (await task.fn(INPUT)) as { draft: { status: string } };

    expect(result.draft.status).toBe("pending");
    const decisionCount = await memory.query<{ c: number | bigint }>(
      "SELECT COUNT(*) as c FROM decisions WHERE account_id = $accountId",
      { accountId: "acc_1" },
    );
    expect(Number(decisionCount[0]?.c ?? -1)).toBe(1);
    expect(await countRows("outcomes")).toBe(0);
  });

  it("approve-and-dispatch's task body IS approveAndDispatch (dispatches through the ONE gated path)", async () => {
    const draft = await savePendingDraft("dr_reg_aad");
    const mock = makeMockHatchet();
    registerRuntimeWorkflows(mock.client, fullDeps(new LocalOutreachChannel(outboxDir)));

    const task = need(
      mock.byName(RUNTIME_WORKFLOW_NAMES.approveAndDispatch),
      "approve-and-dispatch not registered",
    );
    const outcome = (await task.fn({ draftId: draft.id, actor: "human" })) as {
      result: string;
      refId: string;
    };

    expect(outcome.result).toBe("sent");
    expect(outcome.refId).toBe(draft.id);
    const dispatched = await memory.getDraft(draft.id);
    expect(dispatched?.status).toBe("dispatched");
    expect(await readdir(outboxDir)).toContain(`${draft.id}.json`);
    expect(await memory.verifyAuditChain()).toBe(true);
  });

  it("startWorker registers all three on a worker and starts it", async () => {
    const mock = makeMockHatchet();
    const tasks = registerRuntimeWorkflows(mock.client, fullDeps(new LocalOutreachChannel(outboxDir)));

    const worker = await tasks.startWorker("test-worker");
    expect(worker).toBeDefined();
    expect(mock.workers).toHaveLength(1);
    expect(mock.workers[0]?.name).toBe("test-worker");
    expect(mock.workers[0]?.workflowCount).toBe(3);
    expect(mock.workers[0]?.started).toBe(true);
  });
});

/* ───────────────── 3. HatchetExecutor triggers steps as tasks (mock) ─────────────── */

describe("HatchetExecutor — triggers steps as Hatchet tasks (mock client)", () => {
  it("run declares a task named <name>, uses the step as its body, and returns the run result", async () => {
    const mock = makeMockHatchet();
    const executor = new HatchetExecutor(mock.client, { retries: 3 });

    const out = await executor.run("double", { n: 10 }, async (i) => ({ v: i.n * 2 }));
    expect(out).toEqual({ v: 20 });

    expect(mock.tasks).toHaveLength(1);
    const rec = need(mock.byName("double"), "task 'double' not declared");
    expect(rec.retries).toBe(3);
    // the recorded body IS the step: invoking it directly runs the step logic.
    const viaBody = (await rec.fn({ n: 4 })) as { v: number };
    expect(viaBody.v).toBe(8);
  });

  it("reuses one task per name across many runs (one task, many runs)", async () => {
    const mock = makeMockHatchet();
    const executor = new HatchetExecutor(mock.client);

    await executor.run("wf", 1, async (i) => i + 1);
    await executor.run("wf", 2, async (i) => i + 1);
    await executor.run("wf", 3, async (i) => i + 1);

    expect(mock.tasks).toHaveLength(1); // declared once
    expect(need(mock.byName("wf"), "task 'wf' not declared").runInputs).toEqual([1, 2, 3]);
  });

  it("runs the real content-review step body through the executor (pending drafts, nothing sent)", async () => {
    const mock = makeMockHatchet();
    const executor = new HatchetExecutor(mock.client);

    const cr = await executor.run(RUNTIME_WORKFLOW_NAMES.contentReview, REQUEST, (r) =>
      runContentReview(r, { memory, draftStore, reviewFn: cannedReviewFn() }),
    );

    expect(cr.drafts.partnerEmail.status).toBe("pending");
    expect(await countRows("outcomes")).toBe(0);
  });
});

/* ───────── 4. idempotency — what makes Hatchet's at-least-once retries safe ───────── */

describe("idempotency makes at-least-once retries / crash-resume safe", () => {
  it("a retried approveAndDispatch on an already-dispatched draft is refused (exactly one send)", async () => {
    const executor: Executor = new DirectExecutor(); // engine-agnostic: the guard lives in the step
    const channel = new LocalOutreachChannel(outboxDir);
    const draft = await savePendingDraft("dr_retry_aad");

    const runOnce = () =>
      executor.run(
        RUNTIME_WORKFLOW_NAMES.approveAndDispatch,
        { draftId: draft.id, actor: "human" },
        (i) => approveAndDispatch(i.draftId, i.actor, channel, { memory, draftStore }),
      );

    const outcome = await runOnce();
    expect(outcome.result).toBe("sent");

    // simulate Hatchet re-delivering the same task (at-least-once): the second attempt is refused.
    await expect(runOnce()).rejects.toThrow(/already dispatched/);

    expect(await countRows("outcomes", draft.id)).toBe(1);
    expect(await outboxJsonCount()).toBe(1);
    expect(await memory.verifyAuditChain()).toBe(true);
  });

  it("a retried dispatchDraft on an already-dispatched draft is refused (no double-send)", async () => {
    const channel = new LocalOutreachChannel(outboxDir);
    const draft = await savePendingDraft("dr_retry_dd");
    const approval = await draftStore.approve(draft.id, "human");
    const approved = need(await memory.getDraft(draft.id), "expected an approved draft");

    const executor: Executor = new DirectExecutor();
    const runDispatch = () =>
      executor.run("dispatch", { draft: approved, approval }, (i) =>
        dispatchDraft(i.draft, i.approval, channel, memory),
      );

    const outcome = await runDispatch();
    expect(outcome.result).toBe("sent");
    await expect(runDispatch()).rejects.toThrow(/already dispatched/);

    expect(await countRows("outcomes", draft.id)).toBe(1);
  });

  it("when the durable engine re-delivers within one run (mock retry x2), the retry is refused and only one send lands", async () => {
    const mock = makeMockHatchet({ runTimes: 2 }); // the mock invokes each task body twice
    const executor = new HatchetExecutor(mock.client);
    const channel = new LocalOutreachChannel(outboxDir);
    const draft = await savePendingDraft("dr_retry_mock");

    await expect(
      executor.run(
        RUNTIME_WORKFLOW_NAMES.approveAndDispatch,
        { draftId: draft.id, actor: "human" },
        (i) => approveAndDispatch(i.draftId, i.actor, channel, { memory, draftStore }),
      ),
    ).rejects.toThrow(/already dispatched/);

    // the FIRST delivery dispatched exactly once; the second (retry) was refused before any send.
    const dispatched = await memory.getDraft(draft.id);
    expect(dispatched?.status).toBe("dispatched");
    expect(await countRows("outcomes", draft.id)).toBe(1);
    expect(await outboxJsonCount()).toBe(1);
    expect(await memory.verifyAuditChain()).toBe(true);
  });
});
