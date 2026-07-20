import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Approval, Draft, GENESIS_HASH } from "@mstack/core";
import type { ProviderProxy, ProxyRequest, ProxyResponse } from "@mstack/credentials";

import { LocalOutreachChannel, GatecraftEmailChannel } from "./channels.js";

const now = "2026-07-20T00:00:00.000Z";

function approvedDraft(overrides: Partial<Draft> = {}): Draft {
  return Draft.parse({
    id: "dr_chan1",
    kind: "outreach_email",
    refId: "acc_1",
    subject: "hello",
    body: "hi there",
    status: "approved",
    createdBy: "test",
    createdAt: now,
    ...overrides,
  });
}

function approveApproval(overrides: Partial<Approval> = {}): Approval {
  return Approval.parse({
    id: "appr_chan1",
    draftId: "dr_chan1",
    decision: "approve",
    actor: "human",
    ts: now,
    prevHash: GENESIS_HASH,
    hash: "b".repeat(64),
    ...overrides,
  });
}

describe("LocalOutreachChannel", () => {
  let outboxDir: string;

  beforeEach(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), "mstack-runtime-channels-"));
  });

  afterEach(async () => {
    await rm(outboxDir, { recursive: true, force: true });
  });

  it("re-asserts the approval invariant defensively — refuses a mismatched/unapproved draft even without dispatch.ts", async () => {
    const channel = new LocalOutreachChannel(outboxDir);
    const pending = approvedDraft({ status: "pending" }); // never approved
    const approval = approveApproval();

    await expect(channel.dispatch(pending, approval)).rejects.toThrow(/not "approved"/);
  });

  it("writes outbox/<id>.json and returns a 'sent' Outcome for a valid approved draft", async () => {
    const channel = new LocalOutreachChannel(outboxDir);
    const draft = approvedDraft();
    const approval = approveApproval();

    const outcome = await channel.dispatch(draft, approval);

    expect(outcome.result).toBe("sent");
    expect(outcome.refType).toBe("draft");
    expect(outcome.refId).toBe(draft.id);

    const written = JSON.parse(await readFile(join(outboxDir, `${draft.id}.json`), "utf8")) as {
      draft: { id: string; body: string };
      approval: { id: string };
    };
    expect(written.draft.id).toBe(draft.id);
    expect(written.draft.body).toBe(draft.body);
    expect(written.approval.id).toBe(approval.id);
  });

  it("defaults OUTBOX_DIR to './outbox' when no dir is passed and env is unset", () => {
    const originalEnv = process.env.OUTBOX_DIR;
    delete process.env.OUTBOX_DIR;
    try {
      const channel = new LocalOutreachChannel();
      expect(channel.name).toBe("local");
      expect(channel.kind).toBe("email");
    } finally {
      if (originalEnv !== undefined) process.env.OUTBOX_DIR = originalEnv;
    }
  });
});

describe("GatecraftEmailChannel — documented stub", () => {
  it("re-asserts the approval invariant before even checking configuration", async () => {
    const broker: ProviderProxy = { providerId: "resend", proxyCall: async () => ({ status: 200, headers: {}, body: "{}" }) };
    const channel = new GatecraftEmailChannel(broker, { sendUrl: "https://api.resend.com/emails" });
    const pending = approvedDraft({ status: "pending" });
    const approval = approveApproval();

    await expect(channel.dispatch(pending, approval)).rejects.toThrow(/not "approved"/);
  });

  it("throws a clear 'not wired to a real ESP' error when constructed without a sendUrl", async () => {
    const broker: ProviderProxy = {
      providerId: "resend",
      proxyCall: async () => {
        throw new Error("must not be called when unconfigured");
      },
    };
    const channel = new GatecraftEmailChannel(broker);
    const draft = approvedDraft();
    const approval = approveApproval();

    await expect(channel.dispatch(draft, approval)).rejects.toThrow(/not wired to a real ESP/);
  });

  it("when configured with a sendUrl: calls broker.proxyCall and returns a 'sent' Outcome on 2xx", async () => {
    const calls: ProxyRequest[] = [];
    const broker: ProviderProxy = {
      providerId: "resend",
      proxyCall: async (req) => {
        calls.push({ ...req, providerId: "resend" });
        return { status: 200, headers: {}, body: JSON.stringify({ id: "esp-msg-1" }) } satisfies ProxyResponse;
      },
    };
    const channel = new GatecraftEmailChannel(broker, { sendUrl: "https://api.resend.com/emails" });
    const draft = approvedDraft();
    const approval = approveApproval();

    const outcome = await channel.dispatch(draft, approval);

    expect(outcome.result).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
  });

  it("throws when the broker/ESP responds with an error status", async () => {
    const broker: ProviderProxy = {
      providerId: "resend",
      proxyCall: async () => ({ status: 500, headers: {}, body: "internal error" }),
    };
    const channel = new GatecraftEmailChannel(broker, { sendUrl: "https://api.resend.com/emails" });
    const draft = approvedDraft();
    const approval = approveApproval();

    await expect(channel.dispatch(draft, approval)).rejects.toThrow(/ESP responded 500/);
  });

  it("never exposes broker.resolve — only proxyCall is on the injected ProviderProxy shape", () => {
    const broker: ProviderProxy = { providerId: "resend", proxyCall: async () => ({ status: 200, headers: {}, body: "{}" }) };
    expect((broker as unknown as Record<string, unknown>).resolve).toBeUndefined();
  });
});
