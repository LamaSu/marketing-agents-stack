# HumanLayer approver notifier (opt-in doorbell for `@mstack/runtime`)

Design note, not application code — see
`packages/runtime/src/approver-notifier.ts` for the seam and
`research/10-sota-integration-design.md` §2.9 (Wave C4) for the design context.

HumanLayer (~11k★, OmniChannel approver contact over Slack / email) is adopted as an
**optional** way to *notify* a human that a marketing `Draft` is pending approval.

## The boundary — doorbell, not ledger (read this first)

HumanLayer here is a **doorbell**. It only rings ("a draft is pending, go approve it").
It does **not** approve, does **not** dispatch, and does **not** record anything.

- The real record is still the **signed, hash-chained `Approval`** that
  `DraftStore#approve` / `#reject` writes via `MemoryRepo#appendApproval`.
- The only send path is still the gated `dispatch.ts#dispatchDraft`, which refuses any
  draft lacking a matching, on-record, chain-verified `Approval`.
- The approver's reply therefore flows through your **portal/console** (which call
  `DraftStore#approve`/`#reject`) — wiring a HumanLayer *response* back into the gate is a
  deployer concern that MUST go through `DraftStore#approve`; this seam deliberately does
  not do it for you, and cannot (its `notifyPending` returns `void`).

This is enforced structurally, not by convention: `notifyPending(draft): Promise<void>`
returns nothing, the modelled SDK surface has only a one-way "contact a human" method (no
"fetch the approval" call), and the notifier holds no channel and no memory. The offline
guardrail tests in `approver-notifier.test.ts` assert a notified `save()` produces no
`Approval`, no `Outcome`, and no outbox file until `approveAndDispatch` runs.

## License — verified live (2026-07-22)

Checked before choosing to vendor the SDK:

```bash
npm view humanlayer license        # -> Apache-2.0  (version 0.17.2-npm)
npm view @humanlayer/sdk license   # -> Apache-2.0  (version 0.7.9)
```

Apache-2.0 is permissive, so per §2.9 ("SDK if permissive; else a sidecar boundary") the
SDK is **vendored via a lazy dynamic `import(...)`**, mirroring `hatchet-executor.ts` — not
run as an HTTP sidecar. (Had it been copyleft/unclear it would instead be a pure HTTP
sidecar, the `docker/crawl4ai.md` pattern.) The package pinned is **`@humanlayer/sdk`
`^0.7.9`** (clean semver; `humanlayer`'s latest `0.17.2-npm` is a prerelease-tagged string
a caret range would exclude). The loader is injectable, so a deployer can swap packages
without editing source (below).

The SDK is loaded only inside `defaultLoadHumanLayerClient`, via `import("@humanlayer/sdk")`.
Importing `@mstack/runtime` for the offline `noopApproverNotifier` path never reaches it,
so the keyless `mstack demo` needs neither the SDK nor an API key.

## Wire it in (opt-in)

The default `DraftStore` uses `noopApproverNotifier` — nothing changes. To ring HumanLayer
when a draft lands `pending`, pass a notifier as the (optional) 3rd `DraftStore` argument:

```ts
import { DraftStore, humanLayerNotifier } from "@mstack/runtime";

const draftStore = new DraftStore(
  memory,
  "./drafts",
  humanLayerNotifier({
    // apiKey defaults to the HUMANLAYER_API_KEY env var
    contactChannel: { slack: { channel_or_user_id: "C0123APPROVALS" } }, // optional routing
  }),
);
```

```bash
export HUMANLAYER_API_KEY=hl_...   # used by the default SDK loader
```

`save()` then fires a best-effort notification **after** the draft is persisted. Approving
still happens in your portal/console (which calls `DraftStore#approve`), exactly as before.

## The SDK surface this assumes (verify on first real use)

Written offline (no `pnpm install`, per `docs/build-conventions.md`). The default loader
assumes `@humanlayer/sdk` exposes a `humanlayer({ apiKey })` factory **or** a `HumanLayer`
class whose instance has a one-way `createHumanContact(spec) => Promise<...>` method — NOT
`requireApproval`/`fetchHumanApproval` (those BLOCK for the human's decision and would make
HumanLayer the ledger). If your installed version differs, you have two edit-free options:

```ts
// (a) inject a client that matches your SDK's surface
humanLayerNotifier({ client: { createHumanContact: (spec) => myHl.contact(spec) } });

// (b) inject a lazy loader (e.g. to point at the `humanlayer` package instead)
humanLayerNotifier({ loadClient: async () => {
  const { humanlayer } = await import("humanlayer");
  const hl = humanlayer({ apiKey: process.env.HUMANLAYER_API_KEY });
  return { createHumanContact: (spec) => hl.createHumanContact(spec) };
}});
```

Only if neither fits should you adapt `defaultLoadHumanLayerClient` in
`approver-notifier.ts` — the seam, `humanLayerNotifier`, and every test are unaffected.

## Offline default — nothing requires this

`mstack demo` never constructs a `humanLayerNotifier`; `DraftStore`'s default is the
no-op, so the demo runs green with zero network and no API key. Even when the notifier
*is* wired in, any failure (SDK missing, bad key, HumanLayer unreachable, a call that
throws) logs a warning and degrades to the no-op — the draft is still safely `pending` and
visible in the portal. A failed doorbell never blocks or corrupts the approval gate.
