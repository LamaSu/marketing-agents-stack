import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Approval, Draft } from "@mstack/core";
import { ComposioChannel, assertApproved, createComposioChannel } from "./index.js";
import type { ComposioLike } from "./index.js";

function approvedDraft(overrides: Record<string, unknown> = {}) {
  return Draft.parse({
    id: "d1",
    kind: "outreach_email",
    refId: "acme.com",
    subject: "Hi",
    body: "Hello there",
    channel: "email",
    status: "approved",
    createdBy: "account-intel",
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  });
}

function approval(overrides: Record<string, unknown> = {}) {
  return Approval.parse({
    id: "ap1",
    draftId: "d1",
    decision: "approve",
    actor: "human",
    ts: "2026-07-21T00:00:00.000Z",
    prevHash: "0".repeat(64),
    hash: "a".repeat(64),
    ...overrides,
  });
}

function fakeComposio() {
  const execute = vi.fn(async () => ({ successful: true, data: { id: "msg_1" } }));
  return { client: { execute } as unknown as ComposioLike, execute };
}

describe("ComposioChannel — the gated send path", () => {
  it("dispatches an approved draft: asserts, executes the Composio action once, returns a 'sent' Outcome", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, { action: "GMAIL_SEND_EMAIL" });

    const outcome = await channel.dispatch(approvedDraft(), approval());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      action: "GMAIL_SEND_EMAIL",
      params: { recipient: "acme.com", subject: "Hi", body: "Hello there" },
      entityId: undefined,
      connectedAccountId: undefined,
    });
    expect(outcome.result).toBe("sent");
    expect(outcome.refType).toBe("draft");
    expect(outcome.refId).toBe("d1");
    expect(outcome.metrics).toEqual({ composioAction: "GMAIL_SEND_EMAIL" });
  });

  it("honors a custom mapDraft + entity/connected-account routing", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, {
      action: "SLACK_SEND_MESSAGE",
      kind: "slack",
      name: "composio-slack",
      mapDraft: (d) => ({ channel: "#gtm", text: d.body }),
      entityId: "user_7",
      connectedAccountId: "ca_42",
    });

    await channel.dispatch(approvedDraft(), approval());

    expect(channel.name).toBe("composio-slack");
    expect(channel.kind).toBe("slack");
    expect(execute).toHaveBeenCalledWith({
      action: "SLACK_SEND_MESSAGE",
      params: { channel: "#gtm", text: "Hello there" },
      entityId: "user_7",
      connectedAccountId: "ca_42",
    });
  });

  it("refuses when NO Approval is supplied — and never touches Composio", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, { action: "GMAIL_SEND_EMAIL" });
    await expect(
      channel.dispatch(approvedDraft(), undefined as unknown as Approval),
    ).rejects.toThrow(/no Approval supplied/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses when the decision is not 'approve' — and never touches Composio", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, { action: "GMAIL_SEND_EMAIL" });
    await expect(
      channel.dispatch(approvedDraft(), approval({ decision: "reject" })),
    ).rejects.toThrow(/not "approve"/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses when the approval is for a different draft — and never touches Composio", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, { action: "GMAIL_SEND_EMAIL" });
    await expect(
      channel.dispatch(approvedDraft(), approval({ draftId: "someone-else" })),
    ).rejects.toThrow(/is for draft "someone-else"/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses when the draft status is not 'approved' — and never touches Composio", async () => {
    const { client, execute } = fakeComposio();
    const channel = new ComposioChannel(client, { action: "GMAIL_SEND_EMAIL" });
    await expect(
      channel.dispatch(approvedDraft({ status: "pending" }), approval()),
    ).rejects.toThrow(/not "approved"/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("surfaces a Composio action failure instead of reporting a fabricated send", async () => {
    const execute = vi.fn(async () => ({ successful: false, error: "rate limited" }));
    const channel = new ComposioChannel({ execute } as unknown as ComposioLike, {
      action: "GMAIL_SEND_EMAIL",
    });
    await expect(channel.dispatch(approvedDraft(), approval())).rejects.toThrow(/rate limited/);
  });
});

describe("assertApproved (the standalone guard)", () => {
  it("narrows a valid approval and throws on each violation in order", () => {
    expect(() => assertApproved(approvedDraft(), approval())).not.toThrow();
    expect(() => assertApproved(approvedDraft(), null)).toThrow(/no Approval/);
    expect(() => assertApproved(approvedDraft(), approval({ decision: "edit" }))).toThrow(/not "approve"/);
  });
});

describe("offline & single-send-path guarantees", () => {
  it("the package imports and runs with NO @composio/core installed (SDK is lazy)", () => {
    // The mere fact this test file imported ./index.js and reached here proves
    // @composio/core is not a static dependency — it is only import()-ed inside
    // createComposioChannel, which these offline tests never call.
    expect(typeof createComposioChannel).toBe("function");
  });

  it("defines dispatch but NEVER calls a .dispatch() — no second send path", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), "utf8");
      // a CALL site is `<expr>.dispatch(`; a METHOD DEFINITION is `dispatch(` with
      // no preceding dot. This package must only DEFINE dispatch, never CALL one.
      const callSites = source.match(/\.\s*dispatch\s*\(/g) ?? [];
      expect(callSites, `${file} must contain zero .dispatch() call sites`).toHaveLength(0);
    }
  });
});
