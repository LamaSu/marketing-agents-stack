/**
 * channels.ts — `OutreachChannel` implementations (`@mstack/core`'s seam, `seams.ts`).
 * Neither implementation exposes a `send()` — the seam interface itself only has `dispatch`,
 * and every implementation here re-asserts the approval invariant defensively (the seam's own
 * doc comment: "Implementations MUST verify the approval matches the draft and is `approve`.")
 * even though `dispatch.ts#dispatchDraft` is the only caller in this repo. A channel must
 * never trust its caller blindly — it is the last code standing between an approval and an
 * (offline-simulated, or real) external send.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { newId, nowIso, Outcome } from "@mstack/core";
import type { Approval, Draft } from "@mstack/core";
import type { OutreachChannel } from "@mstack/core";
import type { ProviderProxy } from "@mstack/credentials";

import { assertApproved } from "./dispatch.js";

const DEFAULT_OUTBOX_DIR = "./outbox";

function resolveOutboxDir(explicit?: string): string {
  return explicit ?? process.env.OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR;
}

/**
 * The offline default `OutreachChannel`. "Sends" by writing the approved draft to
 * `outbox/<draftId>.json` — no network call, nothing leaves the filesystem. This is what lets
 * the whole demo loop (research/06-architecture.md §5.2) run to a real `dispatched` state with
 * zero credentials.
 */
export class LocalOutreachChannel implements OutreachChannel {
  readonly name = "local";
  readonly kind = "email";
  readonly #outboxDir: string;

  constructor(outboxDir?: string) {
    this.#outboxDir = resolveOutboxDir(outboxDir);
  }

  async dispatch(draft: Draft, approval: Approval): Promise<Outcome> {
    assertApproved(draft, approval);

    await mkdir(this.#outboxDir, { recursive: true });
    const filePath = join(this.#outboxDir, `${draft.id}.json`);
    const record = { draft, approval, sentAt: nowIso() };
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");

    return Outcome.parse({
      id: newId("out"),
      refType: "draft",
      refId: draft.id,
      result: "sent",
      metrics: { outboxPath: filePath },
      ts: nowIso(),
    });
  }
}

export interface GatecraftEmailChannelOptions {
  /** the ESP's send endpoint. No default: there is no real ESP wired up yet (see below). The
   *  `broker` passed to the constructor is expected to already be scoped to a registered
   *  provider id (e.g. via `forProvider(rawBroker, "resend")` — see `@mstack/credentials`'
   *  `registry.ts` `SAMPLE_PROVIDERS`); this class does not carry a separate providerId. */
  sendUrl?: string;
}

/**
 * A DOCUMENTED STUB, not a working email channel. It shows the shape a real ESP-backed
 * `OutreachChannel` would take — dispatch via the credential broker's `proxyCall` (so the raw
 * API key never enters this process; see `@mstack/credentials`' KEY INVARIANT) — but no real
 * transactional-email vendor is registered or configured against it yet (`.env.example` has
 * `RESEND_API_KEY` as an open slot for a future adapter task). Calling `dispatch()` without a
 * `sendUrl` throws rather than silently pretending to send: an unconfigured channel must fail
 * loudly, not report a fabricated `Outcome`.
 */
export class GatecraftEmailChannel implements OutreachChannel {
  readonly name = "gatecraft-email";
  readonly kind = "email";
  readonly #broker: ProviderProxy;
  readonly #opts: GatecraftEmailChannelOptions;

  constructor(broker: ProviderProxy, opts: GatecraftEmailChannelOptions = {}) {
    this.#broker = broker;
    this.#opts = opts;
  }

  async dispatch(draft: Draft, approval: Approval): Promise<Outcome> {
    assertApproved(draft, approval);

    if (!this.#opts.sendUrl) {
      throw new Error(
        "GatecraftEmailChannel.dispatch: not wired to a real ESP — this is a documented stub " +
          "(see channels.ts file header). Construct it with { sendUrl } pointing at a " +
          "registered email provider's send endpoint to actually send, or use " +
          "LocalOutreachChannel for the offline path.",
      );
    }

    // The real-send shape: `broker.proxyCall` never hands this class the raw credential (the
    // `@mstack/credentials` KEY INVARIANT) — it injects auth server-side and returns only the
    // HTTP response.
    const res = await this.#broker.proxyCall({
      method: "POST",
      url: this.#opts.sendUrl,
      body: { to: draft.refId, subject: draft.subject ?? "", body: draft.body },
      authInject: { header: "Authorization" },
    });

    if (res.status >= 400) {
      throw new Error(`GatecraftEmailChannel.dispatch: ESP responded ${res.status}: ${res.body}`);
    }

    return Outcome.parse({
      id: newId("out"),
      refType: "draft",
      refId: draft.id,
      result: "sent",
      metrics: { espStatus: res.status },
      ts: nowIso(),
    });
  }
}
