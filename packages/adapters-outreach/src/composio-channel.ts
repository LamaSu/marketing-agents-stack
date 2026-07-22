/**
 * composio-channel.ts — a gated `OutreachChannel` (`@mstack/core`'s seam,
 * `seams.ts`) backed by **Composio** (the action/integration layer — 1000+ app
 * actions behind one API), per research/10-sota-integration-design.md §2.3
 * (account-intel / GTM, Wave C1).
 *
 * MECHANICAL GUARDRAIL #2 ("a human approves every send") — the reason this
 * file exists and the reason it is safe: a `ComposioChannel` gets Composio's
 * enormous send reach (Gmail/Slack/Outreach/HubSpot/…), but it can send ONLY
 * the same way every other channel can — by being handed a matching, approved
 * `Approval`. `dispatch(draft, approval)` re-asserts the structural invariant
 * (`assertApproved`, below) BEFORE it ever calls Composio, exactly as
 * `@mstack/runtime`'s `LocalOutreachChannel` / `GatecraftEmailChannel` do (the
 * seam's own doc-comment: "Implementations MUST verify the approval matches the
 * draft and is `approve`."). There is no `send()` and no second dispatch path:
 * Composio is reachable only through the one gated `dispatchDraft` in
 * `@mstack/runtime`, which re-derives everything from the system of record
 * before it calls this channel at all.
 *
 * WHY A LOCAL `assertApproved` INSTEAD OF IMPORTING RUNTIME'S: the canonical
 * `assertApproved` lives in `@mstack/runtime`'s `dispatch.ts`. An adapter package
 * must not reverse-depend on `@mstack/runtime` (adapters sit UNDER the runtime,
 * not over it). The seam contract already expects every channel to carry its own
 * defensive re-assertion, so this file re-implements the SAME four checks in the
 * SAME order with the SAME message shape — a guard, never a second send path.
 *
 * WHY A LAZY DYNAMIC IMPORT FOR THE SDK: `@composio/core` is a heavyweight HTTP/
 * SDK client. Statically importing it from a file `index.ts` re-exports would
 * drag it into the offline graph. So the `ComposioChannel` class is pure
 * dependency-injection over a minimal structural `ComposioLike` — fully offline-
 * testable with a fake — and `createComposioChannel()` is the ONE place the real
 * SDK is loaded, via a dynamic `import(...)`, mirroring
 * `@mstack/runtime`'s `createHatchetExecutor`. The keyless `mstack demo` never
 * touches this package at all; nothing here is on the offline path.
 *
 * LIVE-VERIFIED (2026-07-21, researcher pass — see research/wave-c-composio-
 * live-verify.md, gitignored):
 *   - Package: **`@composio/core`** (latest 0.14.0) is the current SDK. The older
 *     `composio-core` (0.5.x) is npm-DEPRECATED ("no longer supported") — do NOT
 *     use it. `@composio/slim` is a smaller same-API variant.
 *   - License: **MIT** at the repo root `LICENSE` (ComposioHQ/composio, ©2025
 *     Sampark Inc.); the published `@composio/core` package.json declares
 *     **`ISC`**. Both are permissive/OSI-approved — no copyleft — but an
 *     automated SPDX checker will read "ISC". Run a manual license-checker pass
 *     before shipping a vendored build.
 *   - Managed-OAuth `initiate()` is already deprecated (400 for all orgs since
 *     2026-07-03). Build auth against Hosted Auth (Connect Link /
 *     `connectedAccounts.link()`) or non-OAuth (API-key/bearer) schemes. This
 *     channel is auth-AGNOSTIC: it takes an already-constructed client (or, in
 *     the factory, an opaque apiKey) and a resolved `connectedAccountId`; HOW the
 *     connected account was established is out of this package's scope.
 *
 * ASSUMPTION — VERIFY ON THE SPARK BUILD (written without `pnpm install` per
 * docs/build-conventions.md): the `@composio/core` v0.14 execute surface adapted
 * in `createComposioChannel` is `new Composio({ apiKey }).tools.execute(slug, {
 * arguments, userId?, connectedAccountId? })` → `{ data, error, successful }`. If
 * a live install differs, fix the adapter in `createComposioChannel` ONLY — the
 * `ComposioChannel` class, `ComposioLike`, and every test are unaffected. Same
 * discipline as `hatchet-executor.ts`'s `HatchetLike` and `crawl4ai.ts`'s
 * response-shape assumptions.
 */
import { newId, nowIso, Outcome } from "@mstack/core";
import type { Approval, Draft, OutreachChannel } from "@mstack/core";

/* ─────────────── the Composio surface we depend on (structural) ─────────────── */

/** Params for one Composio action execution — the subset this channel sets. */
export interface ComposioExecuteParams {
  /** Composio action/tool slug, e.g. "GMAIL_SEND_EMAIL" or "SLACK_SEND_MESSAGE". */
  action: string;
  /** the action's arguments (recipient/subject/body/… — shape depends on the action). */
  params: Record<string, unknown>;
  /** Composio "entity"/user id that owns the connected account (opaque; opt-in). */
  entityId?: string;
  /** a specific connected account to route through (opaque; opt-in). */
  connectedAccountId?: string;
}

/** What a Composio execution returns — the subset this channel reads. */
export interface ComposioExecuteResult {
  successful?: boolean;
  data?: unknown;
  error?: string | null;
}

/**
 * The minimal Composio client surface this channel uses. The real
 * `@composio/core` client is adapted to this by `createComposioChannel`; tests
 * pass a fake. Kept intentionally narrow so a change in the SDK's method names
 * is a one-line fix in the adapter, never a change to this channel or its tests.
 */
export interface ComposioLike {
  execute(params: ComposioExecuteParams): Promise<ComposioExecuteResult>;
}

/* ─────────────────────────── the structural guard ─────────────────────────── */

/**
 * The pure, argument-level guardrail: are `draft` and `approval` structurally
 * consistent and is this an actual approval? Throws a specific `Error` on the
 * first violation (missing Approval, wrong decision, wrong draftId, wrong draft
 * status — same order, same shape as `@mstack/runtime`'s `assertApproved`) and
 * otherwise narrows `approval` to non-null. Deliberately argument-only: the
 * system-of-record verification (the approval is a real hash-chained row) is
 * owned upstream by `dispatchDraft`; this is the channel's defensive last check.
 */
export function assertApproved(
  draft: Draft,
  approval: Approval | undefined | null,
): asserts approval is Approval {
  if (!approval) {
    throw new Error(`ComposioChannel.dispatch: refused — no Approval supplied for draft "${draft.id}"`);
  }
  if (approval.decision !== "approve") {
    throw new Error(
      `ComposioChannel.dispatch: refused — Approval "${approval.id}" decision is "${approval.decision}", not "approve"`,
    );
  }
  if (approval.draftId !== draft.id) {
    throw new Error(
      `ComposioChannel.dispatch: refused — Approval "${approval.id}" is for draft "${String(approval.draftId)}", not "${draft.id}"`,
    );
  }
  if (draft.status !== "approved") {
    throw new Error(
      `ComposioChannel.dispatch: refused — draft "${draft.id}" has status "${draft.status}", not "approved"`,
    );
  }
}

/* ─────────────────────────────── the channel ─────────────────────────────── */

export interface ComposioChannelOptions {
  /** the Composio action/tool slug a send invokes, e.g. "GMAIL_SEND_EMAIL". */
  action: string;
  /** seam-required channel name. Default "composio". */
  name?: string;
  /** seam-required channel kind label, e.g. "email" | "slack". Default "email". */
  kind?: string;
  /** map an approved `Draft` to the action's argument object. Default: a generic
   *  email shape (`{ recipient: draft.refId, subject, body }`). Override per action. */
  mapDraft?: (draft: Draft) => Record<string, unknown>;
  /** Composio entity/connected-account routing (opaque; established out-of-band —
   *  see the OAuth note in the file header). */
  entityId?: string;
  connectedAccountId?: string;
}

function defaultMapDraft(draft: Draft): Record<string, unknown> {
  return { recipient: draft.refId, subject: draft.subject ?? "", body: draft.body };
}

/**
 * A gated `OutreachChannel` that sends via a Composio action. Pure DI over a
 * `ComposioLike` client — construct it directly with a fake for fully-offline
 * tests, or via `createComposioChannel()` for the real SDK. `dispatch()` asserts
 * the approval FIRST (throws before the client is ever touched), then executes
 * the configured Composio action with the mapped draft params.
 */
export class ComposioChannel implements OutreachChannel {
  readonly name: string;
  readonly kind: string;
  readonly #client: ComposioLike;
  readonly #action: string;
  readonly #mapDraft: (draft: Draft) => Record<string, unknown>;
  readonly #entityId?: string;
  readonly #connectedAccountId?: string;

  constructor(client: ComposioLike, opts: ComposioChannelOptions) {
    this.#client = client;
    this.#action = opts.action;
    this.name = opts.name ?? "composio";
    this.kind = opts.kind ?? "email";
    this.#mapDraft = opts.mapDraft ?? defaultMapDraft;
    this.#entityId = opts.entityId;
    this.#connectedAccountId = opts.connectedAccountId;
  }

  async dispatch(draft: Draft, approval: Approval): Promise<Outcome> {
    // Guardrail #2: refuse anything that isn't a matching, approved Approval —
    // BEFORE Composio is touched. Never a partial send.
    assertApproved(draft, approval);

    const result = await this.#client.execute({
      action: this.#action,
      params: this.#mapDraft(draft),
      entityId: this.#entityId,
      connectedAccountId: this.#connectedAccountId,
    });

    if (result.successful === false) {
      throw new Error(
        `ComposioChannel.dispatch: Composio action "${this.#action}" failed: ${result.error ?? "unknown error"}`,
      );
    }

    return Outcome.parse({
      id: newId("out"),
      refType: "draft",
      refId: draft.id,
      result: "sent",
      metrics: { composioAction: this.#action },
      ts: nowIso(),
    });
  }
}

/* ───────────────── opt-in: build a channel on the real SDK ───────────────── */

export interface CreateComposioChannelOptions extends ComposioChannelOptions {
  /** Composio API key. REQUIRED and explicit — this package never auto-reads
   *  `process.env` for a secret (matching `@mstack/adapters-enrichment`'s
   *  explicit-required-client discipline; a URL default is fine, a key is not).
   *  NOTE: handing a raw key to a 3rd-party SDK constructor is a real, documented
   *  tension with "creds never in agent context" — the Infisical/DPoP resolution
   *  is Wave D2 (research/10-sota-integration-design.md §2.10), out of scope here.
   *  Until then, prefer running this behind a deployer-controlled boundary. */
  apiKey: string;
  /** extra config forwarded to the SDK constructor, if your version takes it. */
  config?: Record<string, unknown>;
}

/** Adapt the real `@composio/core` client to `ComposioLike`. The ONE place the
 *  SDK's execute surface is named — see the file-header ASSUMPTION. */
function adaptComposio(sdk: {
  tools: {
    execute(
      slug: string,
      body: { arguments: Record<string, unknown>; userId?: string; connectedAccountId?: string },
    ): Promise<ComposioExecuteResult>;
  };
}): ComposioLike {
  return {
    execute: (p) =>
      sdk.tools.execute(p.action, {
        arguments: p.params,
        userId: p.entityId,
        connectedAccountId: p.connectedAccountId,
      }),
  };
}

/**
 * Construct a `ComposioChannel` backed by a REAL `@composio/core` client. Loads
 * the SDK via a DYNAMIC import so it is pulled in ONLY when a deployer opts into
 * Composio here — importing `@mstack/adapters-outreach` for the class/types
 * never triggers it, keeping the offline graph SDK-free.
 */
export async function createComposioChannel(
  opts: CreateComposioChannelOptions,
): Promise<ComposioChannel> {
  const mod = (await import("@composio/core")) as unknown as {
    Composio: new (cfg: { apiKey: string } & Record<string, unknown>) => Parameters<typeof adaptComposio>[0];
  };
  const sdk = new mod.Composio({ apiKey: opts.apiKey, ...(opts.config ?? {}) });
  return new ComposioChannel(adaptComposio(sdk), opts);
}
