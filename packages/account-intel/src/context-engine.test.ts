import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemory } from "@mstack/memory";
import type { MemoryRepo } from "@mstack/memory";
import { SampleSource } from "@mstack/adapters-signals";
import { SampleProvider } from "@mstack/adapters-enrichment";

import { resolveAccount } from "./context-engine.js";

describe("resolveAccount", () => {
  let memory: MemoryRepo;

  beforeEach(async () => {
    memory = await openMemory(":memory:");
  });

  afterEach(async () => {
    await memory.close();
  });

  it("resolves figma.com from the real sample fixtures with per-field provenance, and persists both account + signals", async () => {
    const result = await resolveAccount(
      { domain: "figma.com" },
      { memory, enrichment: new SampleProvider(), signalSource: new SampleSource() },
    );

    expect(result.account.domain).toBe("figma.com");
    expect(result.account.name).toBe("Figma");
    expect(result.account.firmographic.employees).toBe(1500);
    expect(result.account.provenance.employees).toBe("sample");
    expect(result.account.buyingCommittee.map((c) => c.name)).toContain("Aris Thorne");
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.every((s) => s.actor.company?.toLowerCase() === "figma.com")).toBe(true);
    expect(result.enrichment?.source).toBe("sample");

    // persisted, not just returned in-memory.
    const persistedAccount = await memory.getAccount(result.account.id);
    expect(persistedAccount?.domain).toBe("figma.com");
    const persistedSignals = await memory.getSignalsForAccount("figma.com");
    expect(persistedSignals.length).toBe(result.signals.length);
  });

  it("is idempotent per domain -- a second resolve reuses the same account id instead of minting a new one", async () => {
    const first = await resolveAccount(
      { domain: "figma.com" },
      { memory, enrichment: new SampleProvider(), signalSource: new SampleSource() },
    );
    const second = await resolveAccount(
      { domain: "figma.com" },
      { memory, enrichment: new SampleProvider(), signalSource: new SampleSource() },
    );
    expect(second.account.id).toBe(first.account.id);
  });

  it("degrades gracefully for a domain with no enrichment fixture -- still returns a valid Account, never throws", async () => {
    const result = await resolveAccount(
      { domain: "definitely-not-a-real-fixture-domain.zzz", name: "Ghost Co" },
      { memory, enrichment: new SampleProvider() },
    );
    expect(result.enrichment).toBeNull();
    expect(result.account.name).toBe("Ghost Co"); // falls back to the ref's name hint
    expect(result.account.firmographic.tech).toEqual([]);
    expect(result.signals).toEqual([]); // no signalSource injected -> reads memory only, which is empty
  });

  it("is case-insensitive on the domain ref, matching SampleProvider's own normalization", async () => {
    const result = await resolveAccount(
      { domain: "  Figma.COM  " },
      { memory, enrichment: new SampleProvider() },
    );
    expect(result.account.domain).toBe("figma.com");
    expect(result.account.name).toBe("Figma");
  });
});
