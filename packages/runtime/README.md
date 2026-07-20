# @mstack/runtime

The connective runtime: the draft-first dispatch gate plus the two HITL workflows that wire
`@mstack/reviewer` and `@mstack/account-intel` into the signal → decision → action loop
(`research/06-architecture.md` §3.3, §4). This is where **guardrail #2 — a human approves
every send — becomes a state machine instead of a convention** (`docs/build-conventions.md`).

## Guardrail #2, made mechanical

`src/dispatch.ts#dispatchDraft` is the **only** function in this package — and the only one
in the whole repo — allowed to call `OutreachChannel.dispatch`. Before it touches a channel it
asserts, in order:

1. an `Approval` was actually supplied,
2. `approval.decision === "approve"`,
3. `approval.draftId === draft.id`,
4. `draft.status === "approved"`.

Any failure throws before the channel is ever called. On success it dispatches, marks the
draft `dispatched` in `@mstack/memory`, and persists + returns the canonical `Outcome` row.
Every `OutreachChannel` implementation in `src/channels.ts` re-asserts the same check
defensively (the seam contract in `@mstack/core` requires it), but re-asserting is a guard,
not a second send path — `dispatch.test.ts` grep-scans this package's production source and
asserts there is exactly one `*.dispatch(` **call site**, in `dispatch.ts`.

The only way to reach `dispatchDraft` with an `approved` draft at all is
`src/approve-and-dispatch.ts#approveAndDispatch` — `approve → getDraft → dispatchDraft` — and
that in turn only works on a draft `src/draft-store.ts#DraftStore.save()` put there, which
always forces `status:'pending'` regardless of what its caller passed in. Nothing upstream of
a human decision can ever produce a draft this package will send.

`DraftStore#approve`/`#reject` additionally refuse to act on a draft that is already
`status:'dispatched'` — without that check, re-approving an already-sent draft would flip its
status back to `'approved'` and a retried `approveAndDispatch` would dispatch it a second time.
`'dispatched'` is a terminal state; every other transition (including approving after an
earlier rejection, or retrying an approve that didn't reach dispatch) stays allowed.

## Pieces

| File | Produces |
|---|---|
| `dispatch.ts` | `dispatchDraft` — the one send path; `assertApproved` — the shared guard |
| `draft-store.ts` | `DraftStore` — `save` (always pending) / `listPending` / `approve` / `reject` |
| `channels.ts` | `LocalOutreachChannel` (offline, writes `outbox/`), `GatecraftEmailChannel` (documented stub) |
| `approve-and-dispatch.ts` | `approveAndDispatch`, `rejectDraft` — the human-gated completion |
| `workflows/content-review.ts` | `runContentReview` — reviewFn → persist Review → 2 pending drafts |
| `workflows/account-activation.ts` | `runAccountActivation` — activateFn → persist Decision → 1 pending draft |
| `chorus-adapter.ts` | documentation-only note on how the above register as chorus steps |

Both workflow functions take their agent pipeline **injected** (`reviewFn` / `activateFn`) —
this package does not depend on `@mstack/reviewer` or `@mstack/account-intel`, so it stays
agnostic to whether the real Claude-backed pipeline or a deterministic offline fake is
running underneath. See each workflow file's header for the exact injected shape, and
`chorus-adapter.ts` for a wiring wrinkle worth knowing about (`@mstack/account-intel`'s
`activateAccount` already self-persists and returns a smaller brief type than this package's
`activateFn` contract expects — adapting one to the other is a live-wiring concern, not
something this package resolves).

## Example — offline, end to end

```ts
import { openMemory } from "@mstack/memory";
import {
  DraftStore,
  LocalOutreachChannel,
  runContentReview,
  approveAndDispatch,
} from "@mstack/runtime";

const memory = await openMemory(":memory:");
const draftStore = new DraftStore(memory, "./drafts");
const channel = new LocalOutreachChannel("./outbox");

const { drafts } = await runContentReview(reviewRequest, {
  memory,
  draftStore,
  reviewFn: myReviewerAdapter, // live: wraps @mstack/reviewer; offline: a canned fake
});
// drafts.partnerEmail.status === "pending" — nothing sent yet.

// ... a human looks at drafts/<id>.json and decides to approve ...
const outcome = await approveAndDispatch(drafts.partnerEmail.id, "human@example.com", channel, {
  memory,
  draftStore,
});
// outcome.result === "sent"; outbox/<id>.json now exists; memory.verifyAuditChain() === true.
```

## Config

- `DRAFTS_DIR` env (default `./drafts`) — where `DraftStore` writes the human-facing
  `<id>.json` sidecar for every draft, in addition to persisting to `@mstack/memory`.
- `OUTBOX_DIR` env (default `./outbox`) — where `LocalOutreachChannel` "sends" to (a file, not
  a network call).

## Known simplification

`GatecraftEmailChannel` is a documented stub, not a working ESP integration: it shows the
`broker.proxyCall`-based shape a real send would take but throws if constructed without a
`sendUrl`, since no transactional-email provider is registered yet
(`@mstack/credentials`' `registry.ts`). Wiring a real one is a future connector task.
