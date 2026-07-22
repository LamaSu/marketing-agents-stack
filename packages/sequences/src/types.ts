/**
 * types.ts — the package-local primitives for the multi-step SEQUENCE / CADENCE engine.
 *
 * These are DELIBERATELY package-local (not added to `@mstack/core`'s `schemas.ts` or
 * `seams.ts`): a cadence is an ORCHESTRATION over the existing `Draft` primitive, not a new
 * domain atom. They are Zod schemas (like everything in the stack) so runs validate on the
 * way in and out of the warehouse.
 *
 * THE INVARIANT these types encode: a `SequenceStep` carries a `draftKind` + templates — it
 * describes a DRAFT to queue, never a "send". Nothing here references a channel, a dispatch,
 * or an approval. Turning a step into an actual outbound message still goes, unchanged,
 * through `DraftStore#save` (-> pending) then a human `approve()` then `dispatchDraft` (the
 * one send path in `@mstack/runtime`). See README.md.
 */
import { z } from "zod";
import { DraftKind } from "@mstack/core";

/** One rung of a cadence. `delayDays` is the wait BEFORE this step fires, measured from the
 *  run's `lastStepAt` (so step 0 typically has `delayDays: 0` and fires at start). */
export const SequenceStep = z.object({
  /** 0-based position in the cadence; steps are executed in ascending `order`. */
  order: z.number().int().min(0),
  channel: z.string().default("email"),
  /** Which `Draft.kind` this step queues. Defaults to a cold-outreach email. */
  draftKind: DraftKind.default("outreach_email"),
  /** Optional `{{var}}` template for the draft subject (email only). */
  subjectTemplate: z.string().optional(),
  /** `{{var}}` template for the draft body. Rendered by `render.ts` at queue time. */
  bodyTemplate: z.string(),
  /** Days to wait after the previous step before this one may queue its draft. */
  delayDays: z.number().min(0),
  /** If true, a recorded reply/meeting Outcome stops the run before this step queues. */
  stopIfReplied: z.boolean().default(true),
});
export type SequenceStep = z.infer<typeof SequenceStep>;

/** A named, ordered cadence template. Pure data — reusable across many accounts/runs. */
export const Sequence = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(SequenceStep).min(1),
});
export type Sequence = z.infer<typeof Sequence>;

export const SequenceRunStatus = z.enum(["active", "stopped", "completed"]);
export type SequenceRunStatus = z.infer<typeof SequenceRunStatus>;

/** One live enrollment of an account into a sequence. */
export const SequenceRun = z.object({
  id: z.string(),
  sequenceId: z.string(),
  /** The account this cadence targets — becomes each queued `Draft.refId`. */
  accountRef: z.string(),
  /** Index of the NEXT step to queue (0-based). `currentStep >= steps.length` => done. */
  currentStep: z.number().int().min(0).default(0),
  status: SequenceRunStatus.default("active"),
  startedAt: z.string(),
  /** Timestamp of the last queued step (or the start); the delay clock counts from here. */
  lastStepAt: z.string(),
  /**
   * ADDITIVE (beyond the task's minimal `SequenceRun` shape): the ids of the Drafts this run
   * has queued so far. An `Outcome` references a DRAFT id (not an account), so tracking the
   * queued draft ids lets reply-detection join the run's own drafts to their outcomes with a
   * single indexed lookup and no cross-account guessing. This is orchestration bookkeeping
   * only — it is never a channel and never a send.
   */
  queuedDraftIds: z.array(z.string()).default([]),
});
export type SequenceRun = z.infer<typeof SequenceRun>;
