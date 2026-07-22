/**
 * example.ts — a tiny, offline 2-step outreach cadence used by the tests and as a copy-paste
 * starting point. Every step queues a `pending` draft; nothing here sends. Day 0 opener, then
 * a day-3 follow-up that is skipped if the prospect has already replied.
 */
import { Sequence } from "./types.js";

/** A minimal 2-step cold-outreach cadence: opener (day 0) + follow-up (day 3, stop-on-reply). */
export function exampleSequence(id = "seq_example"): Sequence {
  return Sequence.parse({
    id,
    name: "2-step outreach cadence",
    steps: [
      {
        order: 0,
        channel: "email",
        draftKind: "outreach_email",
        subjectTemplate: "A quick idea for {{accountRef}}",
        bodyTemplate:
          "Hi — I noticed {{accountRef}} might be a fit for what we're building. " +
          "Open to a short chat?",
        delayDays: 0,
        stopIfReplied: true,
      },
      {
        order: 1,
        channel: "email",
        draftKind: "outreach_email",
        subjectTemplate: "Re: A quick idea for {{accountRef}}",
        bodyTemplate:
          "Following up on my earlier note about {{accountRef}} — happy to share a bit more " +
          "whenever the timing is right.",
        delayDays: 3,
        stopIfReplied: true,
      },
    ],
  });
}
