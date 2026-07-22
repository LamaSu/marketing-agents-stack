/**
 * composio-crm-sync.ts — `ComposioCrmSync` / `createComposioCrmSync`, an
 * opt-in `CrmSync` that pushes scores/decisions/outcomes via **Composio**
 * actions (e.g. `"HUBSPOT_UPDATE_CONTACT"`, `"SALESFORCE_UPDATE_RECORD"`)
 * instead of a bespoke HTTP endpoint. Mirrors
 * `adapters-outreach/src/composio-channel.ts`'s lazy-dynamic-import +
 * structural-client shape: this class is pure dependency-injection over a
 * minimal `ComposioLike` (fully offline-testable with a fake); the real
 * `@composio/core` SDK is loaded ONLY inside `createComposioCrmSync`, via a
 * dynamic `import(...)`, so requiring this package's types/class never drags
 * the SDK into the offline graph. The keyless `mstack demo` never touches
 * this file at all.
 *
 * WHY A LOCAL `ComposioLike` INSTEAD OF IMPORTING `adapters-outreach`'s: per
 * `docs/build-conventions.md`, adapter packages depend only on `@mstack/core`
 * — no sideways adapter-to-adapter dependency. The structural shape is
 * duplicated on purpose, the same way `crawl4ai.ts` and `composio-channel.ts`
 * each define their own narrow view of the third-party surface they touch;
 * a change to either copy is a one-file fix, never a cross-package break.
 *
 * ACTION MAPPING IS CALLER-SUPPLIED: unlike outreach (one action per
 * channel), a CRM push needs up to three different Composio actions —
 * score/decision/outcome plausibly hit different HubSpot/Salesforce objects
 * or fields. `ComposioCrmSyncActions` takes one optional `{action, mapArgs}`
 * PER push type; an omitted one silently no-ops that push (same
 * "never breaks the caller" contract as everything else in this package —
 * see `noop-crm-sync` in `crm-sync.ts`).
 *
 * ASSUMPTION — VERIFY ON THE SPARK BUILD (written without `pnpm install` per
 * docs/build-conventions.md): same `@composio/core` v0.14 execute surface as
 * `composio-channel.ts` — `new Composio({ apiKey }).tools.execute(slug, {
 * arguments, userId?, connectedAccountId? })` -> `{ data, error, successful }`.
 * If a live install differs, fix `adaptComposio` ONLY — `ComposioCrmSync`,
 * `ComposioLike`, and every test are unaffected.
 *
 * FAILS SAFE LIKE EVERY OTHER PUSH PATH HERE: a Composio action failure
 * degrades to a console.warn + no-op, the same contract as `httpCrmSync` — a
 * CRM push, via any transport, never throws and never breaks the caller.
 */
import type { Account, Decision, Outcome } from "@mstack/core";
import type { CrmSync } from "./crm-sync.js";

/* ─────────────── the Composio surface this file depends on (structural) ─────────────── */

/** Params for one Composio action execution — the subset this module sets. */
export interface ComposioCrmExecuteParams {
  /** Composio action/tool slug, e.g. "HUBSPOT_UPDATE_CONTACT". */
  action: string;
  /** the action's arguments (shape depends on the action). */
  params: Record<string, unknown>;
  /** Composio "entity"/user id that owns the connected account (opaque; opt-in). */
  entityId?: string;
  /** a specific connected account to route through (opaque; opt-in). */
  connectedAccountId?: string;
}

/** What a Composio execution returns — the subset this module reads. */
export interface ComposioCrmExecuteResult {
  successful?: boolean;
  data?: unknown;
  error?: string | null;
}

/**
 * The minimal Composio client surface this module uses. The real
 * `@composio/core` client is adapted to this by `createComposioCrmSync`;
 * tests pass a fake. Kept intentionally narrow so a change in the SDK's
 * method names is a one-line fix in the adapter, never a change to this
 * class or its tests.
 */
export interface ComposioLike {
  execute(params: ComposioCrmExecuteParams): Promise<ComposioCrmExecuteResult>;
}

/* ─────────────────────────── per-push-type action config ─────────────────────────── */

export interface ComposioCrmSyncActions {
  /** Composio action slug + arg-mapper for a score push. Omit to no-op that method. */
  score?: { action: string; mapArgs: (account: Account) => Record<string, unknown> };
  /** Composio action slug + arg-mapper for a decision push. Omit to no-op that method. */
  decision?: { action: string; mapArgs: (decision: Decision) => Record<string, unknown> };
  /** Composio action slug + arg-mapper for an outcome push. Omit to no-op that method. */
  outcome?: { action: string; mapArgs: (outcome: Outcome) => Record<string, unknown> };
}

export interface ComposioCrmSyncOptions {
  actions: ComposioCrmSyncActions;
  /** seam-required identity. Default "composio". */
  name?: string;
  /** Composio entity/connected-account routing (opaque; established out-of-band —
   *  see the OAuth note in `composio-channel.ts`'s file header, same auth model). */
  entityId?: string;
  connectedAccountId?: string;
}

async function runAction<T>(
  client: ComposioLike,
  label: string,
  cfg: { action: string; mapArgs: (arg: T) => Record<string, unknown> } | undefined,
  arg: T,
  entityId: string | undefined,
  connectedAccountId: string | undefined,
): Promise<void> {
  if (!cfg) return; // no action configured for this push type -- silent no-op, like noopCrmSync
  try {
    const result = await client.execute({
      action: cfg.action,
      params: cfg.mapArgs(arg),
      entityId,
      connectedAccountId,
    });
    if (result.successful === false) {
      throw new Error(result.error ?? "unknown error");
    }
  } catch (err) {
    console.warn(
      `[@mstack/adapters-crm] composioCrmSync: ${label} push via Composio action "${cfg.action}" failed ` +
        `(${String(err)}); degrading to no-op (a CRM push is never allowed to break the caller)`,
    );
  }
}

/**
 * A `CrmSync` that pushes via configured Composio actions. Pure DI over a
 * `ComposioLike` client — construct directly with a fake for offline tests,
 * or via `createComposioCrmSync()` for the real SDK.
 */
export class ComposioCrmSync implements CrmSync {
  readonly name: string;
  readonly #client: ComposioLike;
  readonly #actions: ComposioCrmSyncActions;
  readonly #entityId?: string;
  readonly #connectedAccountId?: string;

  constructor(client: ComposioLike, opts: ComposioCrmSyncOptions) {
    this.#client = client;
    this.#actions = opts.actions;
    this.name = opts.name ?? "composio";
    this.#entityId = opts.entityId;
    this.#connectedAccountId = opts.connectedAccountId;
  }

  async pushScore(account: Account): Promise<void> {
    await runAction(this.#client, "score", this.#actions.score, account, this.#entityId, this.#connectedAccountId);
  }

  async pushDecision(decision: Decision): Promise<void> {
    await runAction(
      this.#client,
      "decision",
      this.#actions.decision,
      decision,
      this.#entityId,
      this.#connectedAccountId,
    );
  }

  async pushOutcome(outcome: Outcome): Promise<void> {
    await runAction(this.#client, "outcome", this.#actions.outcome, outcome, this.#entityId, this.#connectedAccountId);
  }
}

/* ───────────────── opt-in: build a sync on the real SDK ───────────────── */

export interface CreateComposioCrmSyncOptions extends ComposioCrmSyncOptions {
  /** Composio API key. REQUIRED and explicit — this package never auto-reads
   *  `process.env` for a secret (matching `composio-channel.ts`'s discipline).
   *  NOTE: the same documented tension as `adapters-outreach` applies — the
   *  Infisical/DPoP resolution is Wave D2, out of scope here. Prefer running
   *  this behind a deployer-controlled boundary until then. */
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
    ): Promise<ComposioCrmExecuteResult>;
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
 * Construct a `ComposioCrmSync` backed by a REAL `@composio/core` client.
 * Loads the SDK via a DYNAMIC import so it is pulled in ONLY when a deployer
 * opts into Composio here — importing `@mstack/adapters-crm` for the
 * class/types never triggers it, keeping the offline graph SDK-free.
 */
export async function createComposioCrmSync(
  opts: CreateComposioCrmSyncOptions,
): Promise<ComposioCrmSync> {
  const mod = (await import("@composio/core")) as unknown as {
    Composio: new (cfg: { apiKey: string } & Record<string, unknown>) => Parameters<typeof adaptComposio>[0];
  };
  const sdk = new mod.Composio({ apiKey: opts.apiKey, ...(opts.config ?? {}) });
  return new ComposioCrmSync(adaptComposio(sdk), opts);
}
