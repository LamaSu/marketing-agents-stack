/**
 * workflows/account-activation.ts — the `account-activation` chorus workflow
 * (research/06-architecture.md §4.2), minus the HITL-approval + dispatch step
 * (`approve-and-dispatch.ts`, invoked separately once a human — or an autopilot policy —
 * decides).
 *
 * `activateFn` is INJECTED so this file stays agnostic to which account-intel implementation
 * runs — see `chorus-adapter.ts` for the wiring note and an important wrinkle: the real
 * `@mstack/account-intel#activateAccount` already persists its own `Decision`/`Draft` and
 * returns the smaller `AccountDecision` brief, not the full `Decision` this file's `activateFn`
 * contract expects. Adapting one to the other is live-wiring's job, not this package's — this
 * file implements exactly the steps the build task specifies and does not import
 * `@mstack/account-intel`.
 *
 * Steps: `activateFn(input)` -> persist the full `Decision` -> `draftStore.save(draft)`
 * (lands `status:'pending'`) -> return. No channel import, no dispatch — an autopilot
 * auto-approve policy (research/06-architecture.md §8 #2: "never for strategic/VIP accounts")
 * is a decision about whether/when to call `approve-and-dispatch.ts` next, not something this
 * function performs itself.
 */
import { ActivateAccount, Decision } from "@mstack/core";
import type { Draft } from "@mstack/core";
import type { MemoryRepo } from "@mstack/memory";

import type { DraftStore } from "../draft-store.js";

export interface ActivateFnResult {
  decision: Decision;
  draft: Draft;
}

/** The injected account-intel pipeline. Live = an adapter around
 *  `@mstack/account-intel#activateAccount` that yields the full `Decision` primitive (not just
 *  the `AccountDecision` brief); offline/tests = any deterministic function returning the same
 *  shape. `runAccountActivation` is agnostic to which. */
export type ActivateFn = (input: ActivateAccount) => Promise<ActivateFnResult>;

export interface AccountActivationDeps {
  activateFn: ActivateFn;
  memory: MemoryRepo;
  draftStore: DraftStore;
}

export interface AccountActivationResult {
  decision: Decision;
  draft: Draft;
}

/**
 * Run the account-activation workflow up to (not including) human/autopolicy approval.
 * Persists the `Decision` and lands the outreach draft `pending`. Dispatches nothing.
 */
export async function runAccountActivation(
  input: ActivateAccount,
  deps: AccountActivationDeps,
): Promise<AccountActivationResult> {
  const parsed = ActivateAccount.parse(input);

  const { decision, draft } = await deps.activateFn(parsed);

  await deps.memory.putDecision(Decision.parse(decision));
  const savedDraft = await deps.draftStore.save(draft);

  return { decision, draft: savedDraft };
}
