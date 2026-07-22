/**
 * approver-notifier.ts — the opt-in `ApproverNotifier` seam
 * (research/10-sota-integration-design.md §2.9, Wave C4). Adopts **HumanLayer**
 * (Apache-2.0, OmniChannel approver contact over Slack/email) as an OPTIONAL way to
 * *notify* a human that a `Draft` is pending approval.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────┐
 * │ THE BOUNDARY THIS FILE IS ABOUT — HumanLayer is the DOORBELL, not the LEDGER.  │
 * └───────────────────────────────────────────────────────────────────────────────┘
 * This notifier ONLY rings a bell ("a draft is pending, go approve it"). It NEVER
 * dispatches, NEVER writes an `Approval`, and NEVER collects/returns the human's
 * decision. The real record is still the signed, hash-chained `Approval` that
 * `DraftStore#approve` / `#reject` writes (via `MemoryRepo#appendApproval`), and the
 * only send path is still the gated `dispatch.ts#dispatchDraft`. Both are untouched by
 * this file. "Draft-first + a human approves every send" stays exactly the mechanism;
 * this is purely an optional reminder that a decision is waiting.
 *
 * The boundary is enforced structurally, not just by convention:
 *   - `notifyPending(draft): Promise<void>` returns VOID — it is type-impossible for it
 *     to hand a decision back to the caller, so it can never stand in for an approval.
 *   - `HumanLayerLike` (the SDK surface we depend on) models ONLY a one-way
 *     "contact a human" call. It deliberately does NOT model any
 *     `fetchApproval`/`getResponse`/`requireApproval` method — those BLOCK for the
 *     human's answer, which is precisely the ledger role we keep in `DraftStore`.
 *   - the notifier holds no `OutreachChannel` and no `MemoryRepo`, so it structurally
 *     cannot dispatch or persist anything.
 *
 * SHAPE — same "opt-in behind an injectable seam, no-op offline default" idiom as this
 * package's `hatchet-executor.ts` (lazy-dynamic-import of a permissive SDK) and
 * `adapters-enrichment`'s `crawl4ai.ts` / `reviewer`'s `nli-backstop.ts` (graceful
 * degradation, injectable everything):
 *   - `noopApproverNotifier` — the DEFAULT. Does nothing. The offline `mstack demo` (and
 *     the portal/console, which already surface pending drafts on screen) behave exactly
 *     as before this feature existed — zero network, zero config, zero SDK.
 *   - `humanLayerNotifier(config)` — the OPT-IN implementation. Routes a pending-draft
 *     notification over HumanLayer. Degrades to the no-op on ANY failure (SDK missing,
 *     bad key, sidecar down) — a failed doorbell must never block or corrupt the gate.
 *
 * LICENSE — VERIFIED LIVE (2026-07-22, before choosing to vendor): the npm registry
 * (authoritative for the artifact we vendor) reports `@humanlayer/sdk` and `humanlayer`
 * both **Apache-2.0**. Apache-2.0 is permissive, so per §2.9 ("SDK if permissive; else a
 * sidecar boundary") we VENDOR the SDK via a LAZY dynamic `import(...)`, mirroring
 * `hatchet-executor.ts`. Had it been copyleft/unclear this would instead be a pure HTTP
 * sidecar (the `crawl4ai.ts` pattern). See docker/humanlayer.md.
 */
import type { Draft } from "@mstack/core";

/* ─────────────────────────────── the seam ─────────────────────────────── */

/**
 * The optional "a draft is pending" notifier. `notifyPending` fires a best-effort
 * notification and resolves — it returns `void` on purpose: a doorbell reports nothing
 * back, so it can never be mistaken for (or wired into) the approval decision, which
 * remains `DraftStore#approve`'s job alone.
 */
export interface ApproverNotifier {
  notifyPending(draft: Draft): Promise<void>;
}

/**
 * The DEFAULT: notify no one. Fully offline, no SDK, no config. Wiring this in changes
 * nothing — the portal/console already show pending drafts, and the offline demo neither
 * needs nor loads any external notifier. `DraftStore#save` behaves byte-for-byte as it
 * did before the seam existed.
 */
export const noopApproverNotifier: ApproverNotifier = {
  async notifyPending(): Promise<void> {
    /* intentionally does nothing — the pending draft is already the system of record */
  },
};

/* ───────────────── the HumanLayer SDK surface we depend on (structural) ───────────────── */

/**
 * The one-way "contact a human" payload. `msg` is the human-readable reminder;
 * `channel` (optional) is HumanLayer's routing spec (a Slack channel / email address),
 * passed straight through when a deployer configures one.
 */
export interface HumanLayerContactSpec {
  msg: string;
  channel?: unknown;
}

/**
 * The MINIMAL structural description of exactly the HumanLayer SDK surface this file
 * uses — one method, a one-way notification. Written against this (not an SDK import) so
 * the notifier is trivially mockable in tests and the real SDK is loaded only in
 * `defaultLoadHumanLayerClient`.
 *
 * Deliberately one method wide: modelling ONLY the "notify" primitive (and NOT any
 * blocking "fetch the approval" call) is how the doorbell-not-ledger boundary is kept at
 * the SDK surface itself. There is no method here that could return a human's decision.
 */
export interface HumanLayerLike {
  /** Create a one-way human-contact (a notification). Its return value is ignored — we
   *  never read a decision back out of it. */
  createHumanContact(spec: HumanLayerContactSpec): Promise<unknown>;
}

/* ─────────────────────────────── config + defaults ─────────────────────────────── */

export interface HumanLayerNotifierConfig {
  /** Injected structural client — used by tests/DI and by a deployer whose installed SDK
   *  surface differs. When set, no dynamic import happens at all. */
  client?: HumanLayerLike;
  /** Lazily build the client. Defaults to `defaultLoadHumanLayerClient` (dynamic-imports
   *  `@humanlayer/sdk` and adapts it). Injectable so a deployer can point at a different
   *  SDK/package/version WITHOUT editing this file. Called at most once (memoized). */
  loadClient?: () => Promise<HumanLayerLike>;
  /** HumanLayer API key for the default loader. Defaults to the `HUMANLAYER_API_KEY` env
   *  var. Unused when `client` is injected. */
  apiKey?: string;
  /** Optional HumanLayer routing spec (Slack channel / email) attached to every
   *  notification. Defaults to HumanLayer's account-default routing when unset. */
  contactChannel?: unknown;
  /** Build the reminder text from a pending draft. Default: a short, id-anchored summary
   *  that points the human at the portal (and states the decision is recorded there, not
   *  by replying — reinforcing doorbell-not-ledger to the recipient too). */
  formatMessage?: (draft: Draft) => string;
}

/** The default reminder text. Never includes the full draft `body` — a notification is a
 *  pointer to the portal, not a place to approve from. */
export function defaultFormatMessage(draft: Draft): string {
  const subject = draft.subject ?? "(no subject)";
  return (
    "A marketing draft is pending human approval.\n" +
    `- id:      ${draft.id}\n` +
    `- kind:    ${draft.kind}\n` +
    `- channel: ${draft.channel}\n` +
    `- subject: ${subject}\n` +
    "\n" +
    "Approve or reject it in the mstack approvals portal/console. This message is a " +
    "reminder only — the decision is recorded in the portal as a signed, hash-chained " +
    "approval, not by replying here."
  );
}

function buildContactSpec(
  draft: Draft,
  formatMessage: (draft: Draft) => string,
  contactChannel: unknown,
): HumanLayerContactSpec {
  const spec: HumanLayerContactSpec = { msg: formatMessage(draft) };
  if (contactChannel !== undefined) spec.channel = contactChannel;
  return spec;
}

/**
 * The ONE place the real SDK is loaded, via a DYNAMIC `import(...)` — so the heavyweight
 * client is pulled in only when a deployer opts into HumanLayer here. Importing
 * `@mstack/runtime` for the offline `noopApproverNotifier` / `DirectExecutor` path never
 * reaches this, keeping the keyless demo free of the SDK and any API key.
 *
 * ASSUMPTION — VERIFY ON THE SPARK BUILD / FIRST REAL USE (written offline, no
 * `pnpm install`, per docs/build-conventions.md): `@humanlayer/sdk` exposes either a
 * `humanlayer({ apiKey })` factory OR a `HumanLayer` class, whose instance has a
 * `createHumanContact(spec) => Promise<...>` method — the one-way "contact a human"
 * primitive, NOT `requireApproval`/`fetchHumanApproval` (which BLOCK for the human's
 * decision and would make HumanLayer the ledger). If your installed version's factory or
 * method name differs, inject `config.loadClient` (no source edit needed) or adapt THIS
 * one function — the seam, `humanLayerNotifier`, and every test are unaffected. If the
 * loaded module has no usable `createHumanContact`, this throws and the notifier degrades
 * to the no-op (see `humanLayerNotifier`). Docs: docker/humanlayer.md.
 */
export async function defaultLoadHumanLayerClient(
  config: Pick<HumanLayerNotifierConfig, "apiKey"> = {},
): Promise<HumanLayerLike> {
  const mod = (await import("@humanlayer/sdk")) as unknown as {
    humanlayer?: (opts?: { apiKey?: string }) => Partial<HumanLayerLike> | undefined;
    HumanLayer?: new (opts?: { apiKey?: string }) => Partial<HumanLayerLike>;
  };
  const apiKey = config.apiKey ?? process.env["HUMANLAYER_API_KEY"];
  const raw: Partial<HumanLayerLike> | undefined =
    typeof mod.humanlayer === "function"
      ? mod.humanlayer({ apiKey })
      : mod.HumanLayer
        ? new mod.HumanLayer({ apiKey })
        : undefined;

  const createHumanContact = raw?.createHumanContact;
  if (!raw || typeof createHumanContact !== "function") {
    throw new Error(
      "@humanlayer/sdk did not expose a `createHumanContact` method; inject `loadClient` " +
        "or adapt `defaultLoadHumanLayerClient` (see docker/humanlayer.md)",
    );
  }
  return {
    createHumanContact: (spec: HumanLayerContactSpec): Promise<unknown> =>
      createHumanContact.call(raw, spec),
  };
}

/* ─────────────────────────────── the opt-in notifier ─────────────────────────────── */

/**
 * Build an `ApproverNotifier` that rings HumanLayer when a draft is pending. Opt-in — the
 * default remains `noopApproverNotifier`, so nothing about the offline path changes.
 *
 * Graceful degradation, matching every other seam default in this package: if the client
 * can't be loaded (SDK not installed, bad config) it logs ONCE and disables notifications
 * (resolves to no-op); if an individual notification call fails it logs and returns. In
 * every failure mode `notifyPending` still resolves `void` — a failed doorbell never
 * throws, never blocks `DraftStore#save`, never touches the gate.
 */
export function humanLayerNotifier(config: HumanLayerNotifierConfig = {}): ApproverNotifier {
  const formatMessage = config.formatMessage ?? defaultFormatMessage;
  const contactChannel = config.contactChannel;

  // Memoized client resolution. An injected client wins outright; otherwise the loader
  // runs at most once. Resolves to `null` (never rejects) on load failure, so a broken
  // SDK/config disables the doorbell instead of surfacing an error into `save`.
  let clientPromise: Promise<HumanLayerLike | null> | undefined;
  const resolveClient = (): Promise<HumanLayerLike | null> => {
    if (config.client) return Promise.resolve(config.client);
    if (!clientPromise) {
      const load = config.loadClient ?? ((): Promise<HumanLayerLike> => defaultLoadHumanLayerClient(config));
      clientPromise = load().catch((err: unknown): null => {
        console.warn(
          "[@mstack/runtime] humanLayerNotifier: could not load the HumanLayer client " +
            `(${String(err)}); approver notifications are disabled (doorbell off — the draft ` +
            "is still safely pending and visible in the portal).",
        );
        return null;
      });
    }
    return clientPromise;
  };

  return {
    async notifyPending(draft: Draft): Promise<void> {
      const client = await resolveClient();
      if (!client) return;
      try {
        await client.createHumanContact(buildContactSpec(draft, formatMessage, contactChannel));
      } catch (err) {
        console.warn(
          `[@mstack/runtime] humanLayerNotifier: notifying the approver for draft "${draft.id}" ` +
            `failed (${String(err)}); the draft is safely pending regardless (doorbell, not ledger).`,
        );
      }
    },
  };
}
