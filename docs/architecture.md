# Architecture

This document describes the end-to-end system architecture of Stellar Mandates: the
consumer/merchant web app, the merchant API, the untrusted relayer, the Soroban
mandate-registry contract, and the Stellar Asset Contract token interface they all depend on —
including the trust boundaries between each component (PLAN.md §9).

Status: Phase 0-6 built and tested the contract locally. Phase 7 (this section) deployed it to
Stellar testnet, proved it against a real Stellar Asset Contract (not just `mock-token`), and
built the TypeScript client layer everything above the contract will use. Refined further through
Phase 15 (demo polish).

---

## Phase 7 — Deployment and client layering

### Package layering (bottom to top)

```text
contracts/mandate-registry        Rust/Soroban — the policy authority
        │  (stellar contract bindings typescript)
        ▼
packages/contract-client          generated bindings + hand-written domain layer
        │  (i128 -> bigint, BytesN<32> -> hex, tag unions -> discriminated unions)
        ▼
packages/stellar                  tx submission (2 auth flows) + error decoding
        │
packages/shared                   Zod schemas + decimal<->base-unit money conversion
        │
scripts/, apps/api, apps/relayer, apps/web   (apps/* land in later phases)
```

`packages/contract-client` is the only package that imports the generated bindings
(`src/generated/mandate-registry.ts`, committed — see "Generated bindings" below). Everything else
imports the hand-written facade (`src/client.ts`, `src/domain.ts`) or `packages/stellar`'s
submission helpers, never the generated file directly.

### Deployment registry (`deployments/<network>.json`)

Written by `scripts/deploy-testnet.ts`, loaded by `packages/contract-client/src/deployment-registry.ts`.
Contains only public information — contract ids, wasm hash, RPC/network endpoints — so it is
committed, never gitignored. Keyed by network (`testnet`, and eventually `futurenet`/`mainnet`)
so multiple environments coexist without collision.

```json
{
  "network": "testnet",
  "networkPassphrase": "...",
  "contractId": "C...",
  "wasmHash": "...",
  "deployedAt": "2026-...",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "asset": { "code": "PUSD", "issuer": "G...", "contractId": "C...", "decimals": 7 }
}
```

The `asset` field records the SEP-41 test asset used to prove the contract against a **real**
Stellar Asset Contract, not just the local `mock-token` test double (see below).

### Test asset: a real classic asset + SAC, not an existing testnet USDC

`scripts/deploy-testnet.ts` issues a classic Stellar asset (`PUSD`, issued by a repo-controlled
`paymap-asset-issuer` identity) and deploys its Stellar Asset Contract
(`stellar contract asset deploy`). This was chosen over reusing an existing testnet USDC SAC
because the issuer key needs to be under our own control so the payer account can be freely
(re-)funded to any balance the demo needs, with no faucet dependency. A SAC's `approve` /
`allowance` / `transfer_from` / `transfer` / `balance` semantics are identical regardless of which
classic asset it wraps, so this does not weaken the proof at all.

**Result: real SAC semantics matched `mock-token` exactly.** `scripts/create-demo-mandate.ts`'s
`approve` -> `create_mandate` -> `charge` sequence against the real PUSD SAC succeeded with no
divergence from the Phase 3-6 `mock-token`-based test suite's assumptions about the SEP-41
interface. No stop condition was triggered.

### Generated bindings vs. hand-written facade

`packages/contract-client/src/generated/mandate-registry.ts` is produced by
`stellar contract bindings typescript` and committed (regenerate command is in the file's own
header comment). It is excluded from ESLint (`**/generated/**`, `packages/config/eslint.config.mjs`)
but still typechecked as part of `pnpm typecheck` — this required two narrow, documented
deviations in `packages/contract-client/tsconfig.json` (`lib: ["ES2022", "DOM"]` for the codegen
tool's own `typeof window` browser-compat guard, and `noImplicitOverride: false` since the
generated `Client` class overrides `ContractClient` members without the modifier); every other
package keeps the base config's full strictness.

`packages/contract-client/src/domain.ts`/`client.ts` wrap it: every `i128`/`u64` is a `bigint`
(never a JS `number`, CLAUDE.md §5), every `BytesN<32>` id is a lowercase hex string, and
`AmountRule`/`MandateStatus` are proper discriminated unions/string-literal types instead of the
generated `{tag, values}` shape.

### The two authorization flows (`packages/stellar/src/submit.ts`)

Both rely on the generated client's own "simulate before you sign" behavior — every method call
returns an already-simulated `AssembledTransaction`, and `assertSimulatedOk` refuses to proceed to
a signature at all if that simulation already came back `Err`.

1. **Payer-signs-and-submits** (`submitAsInvoker`) — `create_mandate`, `pause_mandate`,
   `resume_mandate`, `revoke_mandate`. The payer is both the invocation's required signer and the
   transaction's source account.
2. **Merchant-authorizes/relayer-submits** (`submitAsRelayer`) — `charge`, `refund`, the core trust
   boundary of the whole product. The relayer is the transaction's source account (pays the fee,
   owns the sequence number) but never signs the merchant's authorization entry; the merchant
   signs only that one Soroban auth entry via `AssembledTransaction.signAuthEntries({ address,
   authorizeEntry })`.

`packages/stellar/src/signer.ts`'s `keypairSigner(secretKey)` wraps a raw `Keypair` as both
callback shapes the SDK needs (`signTransaction` for the tx envelope, an `authorizeEntry` override
for one auth entry) without hand-rolling any hashing/signing logic itself — both delegate straight
to `@stellar/stellar-sdk`'s own `authorizeEntry`/`Transaction.sign`.

**Result: this flow worked exactly as designed on real testnet.** `scripts/create-demo-mandate.ts`
uses three genuinely distinct Stellar identities — payer, merchant, and a separate `paymap-relayer`
— and the relayer never holds the merchant's or payer's key at any point. See the Phase 7 `##
Review` entry in `tasks/todo.md` for the real transaction hashes this produced.

### Error decoding (`packages/stellar/src/errors.ts`)

A frozen table mapping the contract's `u32` error codes (`contracts/mandate-registry/src/error.rs`)
to `{ name, retryable }`, with `retryable` following CLAUDE.md §11's relayer retry policy exactly
(permanent: revoked/expired/duplicate/over-limit/too-soon/max-count; transient, per merchant
policy: insufficient allowance/balance). `packages/stellar/src/errors.test.ts` parses `error.rs`
directly and asserts the TS table never drifts from the Rust source — a mismatch here would
silently misclassify real failures in production.

### Money (`packages/shared/src/money.ts`)

`decimalToBaseUnits`/`baseUnitsToDecimalString` are the only place decimal-string (API-facing) and
integer-base-unit (on-chain, `bigint`) amounts convert between each other (CLAUDE.md §9). Every
classic-asset SAC uses exactly 7 decimals; the conversion functions themselves are asset-agnostic
and take `decimals` as a parameter. Over-precision input is rejected outright, never rounded.

---

## Phase 9 — Relayer (`apps/relayer`)

The relayer executes transactions; it has **zero policy authority and zero spending authority**
(CLAUDE.md §11, PLAN.md §15). Every rule that matters — amount limits, timing, state — is enforced
by the contract, not trusted from the relayer's own judgment. This phase's job was to make that
structural, not conventional: even a buggy or fully compromised relayer process cannot make a
different charge succeed than the one the merchant's `ChargeRequest` actually described.

### Pipeline (`src/pipeline.ts::processChargeRequest`)

```text
1. Claim         guarded DB transition  scheduled|retryable_failed -> processing
2. Fresh read    ChainGateway.getMandate(mandateId)         (never the DB's MandateIndex cache)
3. Build+simulate ChainGateway.prepareCharge(args)           (AssembledTransaction simulates on construction)
4. Classify      a rejected simulation -> classify.ts -> permanent | transient, before any signature
5. Verify        simulated receipt vs. ChargeRequest + its Merchant/Product — merchant, asset,
                 amount, charge_id, mandate_id, invoice_hash. Any mismatch -> hard failure, never a
                 retry (SIMULATION_MISMATCH) — submit() is never called.
6. Submit        processing -> simulated -> submitted, then PreparedCharge.submit() once
7. Poll to final `submit()` blocks until a final on-chain result — the SDK's
                 `AssembledTransaction.signAndSend()` already polls `getTransaction` internally
                 (`SentTransaction.send()`, up to 5 minutes) rather than this app re-implementing
                 that loop.
8. Reconcile     on success: Payment row + `succeeded` transition, ONE Postgres transaction —
                 Payment is written only from the confirmed final Result, never from the
                 pre-submission simulation.
9. Classify      on failure: retryable_failed (+ nextAttemptAt) or permanently_failed
10. Webhook      enqueue a `pending` WebhookDelivery row either way (delivery itself is Phase 12)
```

### The `ChainGateway` seam (`src/chain-gateway.ts`)

`pipeline.ts` depends only on a narrow `ChainGateway` interface (`getMandate`, `prepareCharge` ->
`PreparedCharge { simulated, submit() }`) — never on `@paymap/contract-client`/`@paymap/stellar`
directly. Mirrors `apps/api/src/chain/mandate-reader.ts`'s established pattern. Every Postgres
integration test in this app runs against a deterministic in-memory `FakeChainGateway`
(`src/test/helpers.ts`) — no live Soroban RPC in the default `pnpm test` run; the production
`createSorobanChainGateway` is a thin wrapper proven once against real testnet (see "Real-testnet
proof" below).

### Failure classification (`src/classify.ts`)

One table, two input universes:

- **Contract errors** (all 24 frozen codes, `contracts/mandate-registry/src/error.rs`) — consumes
  `packages/stellar`'s own `retryable` flag rather than re-deriving it (that flag is itself
  drift-tested against the Rust source). An error name outside the frozen table throws
  `UnclassifiableContractError` instead of silently defaulting to a retry.
- **Infra conditions** the relayer itself observes and that never produce a contract error at all:
  `RPC_UNAVAILABLE`, `SEND_FAILED`, `TX_NOT_INCLUDED` — always transient.

| Contract error | Class | Contract error | Class |
| --- | --- | --- | --- |
| MandateNotFound | permanent | InsufficientAllowance | **transient** |
| MandateNotActive | permanent | InsufficientBalance | **transient** |
| MandatePaused | permanent | PaymentNotFound | permanent |
| MandateRevoked | permanent | RefundExceedsPayment | permanent |
| MandateCompleted | permanent | DuplicateRefund | permanent |
| MandateExpired | permanent | ArithmeticOverflow | permanent |
| ChargeBeforeStart | permanent | InvalidMandateInput | permanent |
| ChargeTooSoon | permanent | DuplicateMandate | permanent |
| InvalidAmount | permanent | InvalidStateTransition | permanent |
| AmountExceedsChargeLimit | permanent | RefundNotFound | permanent |
| AmountExceedsPeriodLimit | permanent | | |
| ChargeCountExceeded | permanent | | |
| DuplicateCharge | permanent | | |
| UnauthorizedMerchant | permanent | | |

### Retry schedule (`src/retry-schedule.ts`)

PLAN.md §15: attempt 1 at scheduled time, then +6h, +24h, +72h, then `permanently_failed`.
`nextRetryAt(attemptCount, from)` returns `undefined` once exhausted.

### At-most-one-success under duplicate delivery (decision #2)

BullMQ's deterministic job id (`chargeRequest.id`, `src/queue.ts`) collapses duplicate *enqueues*,
but the system does not rely on BullMQ's own job locking for correctness. The actual guarantee is
the DB-guarded `scheduled|retryable_failed -> processing` transition
(`apps/api/src/state-machine.ts::transitionChargeRequest`, reused verbatim, not re-implemented): a
guarded `updateMany` scoped to the expected current status, so a second concurrent caller's
`updateMany` matches zero rows the instant the first commits, and returns
`skipped_not_claimable` having made **zero** chain calls. Proven with two independent Prisma
connections (simulating two separate worker processes) racing `processChargeRequest` on the same
`ChargeRequest` id against a real Postgres — see `src/pipeline.test.ts`'s "duplicate job delivery"
suite.

### Scheduler (`src/scheduler.ts`)

Finds `scheduled` rows past `scheduledFor` and `retryable_failed` rows past `nextAttemptAt`,
enqueues both with the deterministic job id. Safe to run from multiple relayer processes at once —
BullMQ dedupes the enqueue, and the pipeline's DB claim is the real backstop regardless.

### The one open trust-model question this phase surfaces

`contracts/mandate-registry/src/charge.rs` requires `mandate.merchant.require_auth()` on *every*
call — never the relayer. Nothing built through Phase 8 defines how a merchant's signature for a
specific, server-generated `charge_id` reaches this untrusted process without it custodying a
merchant secret key (which would defeat the whole point of this phase). `ChainGateway`'s
`resolveMerchantSigner` is an injected seam precisely so this isn't silently papered over: the
production entrypoint (`src/index.ts`) throws a clear, actionable error rather than pretending to
work. See `docs/threat-model.md`'s "merchant charge authorization" entry.

### Real-testnet proof

`scripts/run-relayer-testnet-demo.ts` runs one scheduled `ChargeRequest` through the **actual**
pipeline (`processChargeRequest` + `createSorobanChainGateway`) against real testnet — not a
one-off hand-rolled submission. It creates a fresh mandate (payer signs/submits directly, as in
Phase 7), then hands a real `ChargeRequest` row to the same pipeline code the BullMQ worker runs.
Real result (see `tasks/todo.md`'s Phase 9 review for the full transcript):

- mandate id `17943c35498152a43ce01c3119dbfb340a0069877590af2a357d68223dbfff76`
- `create_mandate` tx `8e03653aeddaae57aa8f24176f2f5d51c395356fb97b1c8d75e3166ffbefd5d8`
- relayer-submitted `charge` tx `86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c`
  (ledger `3835099`), driven end-to-end through `processChargeRequest`, resulting in exactly one
  `Payment` row and a `succeeded` `ChargeRequest`.

## Phase 10 — Consumer checkout (`apps/web`)

### A public read/write seam on `apps/api`, not a new service

The checkout page's browser never holds a merchant API key (only `apps/api`'s existing
`Authorization: Bearer` bearer-token routes require one), so Phase 10 added two **unauthenticated**
routes to `apps/api/src/routes/checkout-sessions.ts` rather than inventing a second backend:

- `GET /v1/checkout-sessions/:id/public` — merchant name/wallet address, the product's mandate
  terms, and the session's own status/expiry. Only display-safe fields; no webhook URL, webhook
  secret, or API keys.
- `POST /v1/checkout-sessions/:id/mandate` — the checkout page reports the `mandate_id` it just
  created on-chain. Grants no authority of its own: the handler independently re-reads the mandate
  from chain (`app.mandateReader.getMandate`) and rejects a mismatched merchant/asset/payer before
  persisting anything (CLAUDE.md §2 — the contract remains the policy authority; this row is a
  merchant-dashboard convenience, never proof of anything).

Both routes needed `@fastify/cors` (`app.ts`, `origin: true`) — a merchant's checkout page is
expected to be embedded on an arbitrary merchant-controlled domain, different from `apps/api`'s
own origin, so the browser's fetch is blocked by the same-origin policy without it. CORS gates
browser JS access only, not this API's actual security boundary (the bearer-token check every
other route still requires), so this doesn't weaken auth anywhere.

### Package layering (bottom to top, extending the Phase 7 diagram)

```text
packages/contract-client/{client,domain}.js   browser-safe subpaths (no node:fs)
packages/contract-client (root)               adds deployment-registry.js (Node-only, loadDeployment)
        │
packages/stellar                              + src/token.ts: SEP-41 approve/allowance builders
        │                                       (the mandate-registry generated client only knows
        │                                        that one ABI; a SAC has no published Wasm to derive
        │                                        a spec from, so this drives AssembledTransaction.build
        │                                        directly with hand-built ScVal args)
        ▼
apps/web/src/lib/{wallet,chain-gateway}.ts    the two seams the UI depends on, swappable for tests
        ▼
apps/web/src/components/checkout/*            state machine (lib/checkout-state.ts) + presentation
```

`packages/contract-client`'s root barrel (`export * from "./deployment-registry.js"`) reads
`deployments/<network>.json` via `node:fs` at import time — fine for every Node consumer, but
importing *any* value binding from the root barrel inside a Next.js Client Component drags that
Node-only module into the browser bundle too (a bundler can't tell which named export a mixed
value+type import statement actually needs). `package.json` gained `./client`/`./domain` subpath
exports so `apps/web/src/lib/chain-gateway.ts` (a client-bundled file) can import
`createMandateRegistryClient`/`buildCreateMandate`/`idToHex` without ever pulling in `node:fs`.
`loadDeployment` itself is still only ever called from `app/checkout/[sessionId]/page.tsx` (a
Server Component) and passed down as a plain prop — deployment info is public, so this is a
bundling concern only, not a secrecy one.

### Two-step signing, one component tree

`components/checkout/checkout-flow.tsx` drives `lib/checkout-state.ts`'s reducer through:
connect wallet -> `create_mandate` (payer-signs-and-submits, `submitAsInvoker` — same flow as
Phase 7's demo script) -> bounded `approve` on the product's asset contract (`packages/stellar`'s
new `buildApprove`, amount = `computeMaxExposure` + a disclosed 1% headroom, `computeBoundedAllowance`
in `lib/mandate-terms.ts`) -> `POST .../mandate` to link the session. The reducer's one
load-bearing transition: `CREATE_MANDATE_SUCCESS` sets `mandateId` and it is *never cleared* by a
later `APPROVE_ERROR` — a step-1-succeeds/step-2-fails run renders a "created but not funded yet"
notice with a retry-approve action reading `mandateId` straight off state, never a dead end.

### Testability: `WalletAdapter` and `ChainGateway` as injected seams

Both `lib/wallet.ts` (Stellar Wallets Kit, Freighter + xBull modules) and `lib/chain-gateway.ts`
(the real Soroban calls) are constructed by `components/checkout/checkout-page-client.tsx` and
passed into `CheckoutFlow` as props — never imported directly by the flow/reducer. This is what
lets `e2e/checkout.spec.ts` exercise the real state machine and every rendered term without a
browser wallet extension or live RPC: `NEXT_PUBLIC_E2E_STUBS=1` (set only by
`playwright.config.ts`'s own dev-server invocation) swaps in `lib/test-stubs.ts`'s deterministic
fakes instead. The merchant API itself is stood in for by `e2e/fixtures/mock-api-server.mjs` (plain
`node:http`, no framework) — necessary because the checkout session fetch happens in a Server
Component, which Playwright's browser-level `page.route()` interception cannot see at all.

## Phase 11 — Consumer dashboard (`apps/web`)

### Two data sources with an explicit trust hierarchy

The dashboard (`/dashboard`) reads from two places, and CLAUDE.md §2 decides which one wins on
disagreement:

- **Discovery/enrichment (DB, `apps/api/src/routes/consumer.ts`, unauthenticated)** —
  `GET /v1/consumer/mandates?payerAddress=` lists `MandateIndex` rows for a payer (merchant display
  name, asset address/decimals, a `cachedStatus` deliberately named to signal "last known, not
  authoritative"); `GET /v1/consumer/payments?payerAddress=` lists `Payment`/`ChargeRequest` rows
  for the same discovered mandate ids. Neither endpoint's status/amount fields are ever rendered as
  a mandate's *current* state.
- **Authority (chain, `lib/mandate-gateway.ts`)** — one `get_mandate` simulation call per
  discovered mandate id, run directly from the browser against Soroban RPC. Every field a mandate
  card shows (status, amounts, period usage, next eligible date) is derived from this live read,
  never the DB cache.

This makes `MandateIndex` need a payer-address entry point it didn't have before: only the
merchant-authenticated `GET /v1/mandates/:id` (Phase 8) ever upserted it, and a payer's own browser
never calls that route. `checkout-sessions.ts`'s `/mandate` link endpoint (Phase 10) now also
upserts `MandateIndex` with the verified on-chain `payer` address at the moment a mandate is
linked — the one piece of backend wiring this phase's discovery model depends on.

### `lib/mandate-status.ts` — the formulas, not a second copy of the contract's rules

Pure, bigint-only, unit-tested functions computing what the contract itself doesn't expose via a
read method:

- `deriveEffectiveStatus` — mirrors `lifecycle.rs::effective_status`'s lazy-expiry rule
  (`Active`/`Paused` past `expiresAt` reads as `Expired`). Defense in depth: a live `get_mandate`
  already returns this computed status, so this mostly matters for a `MandateIndex`-cached label
  shown before the live read resolves.
- `computeEffectivePeriodUsage` — the period-usage meter uses the *effective* period at "now", not
  the mandate's raw stored `currentPeriodStart`/`currentPeriodCollected`, so an idle mandate never
  shows a stale "period full" reading (same `floor((t - start_at) / period_seconds)` boundary math
  as `charge.rs`).
- `computeNextEligibleChargeDate` — the one PLAN.md §16.1 card field the contract has no getter
  for at all. Two independent gates: the interval floor
  (`max(startAt, (lastChargedAt ?? startAt) + minIntervalSeconds)`), and a period-allowance check
  that rolls the candidate forward to the next period boundary if that period is already
  (case: `Fixed`) or fully (`Variable`, since the exact next amount is the merchant's future
  choice) exhausted.
- `deriveControlAvailability` — Pause only on `Active`, Resume only on `Paused`, Cancel autopay on
  either — mirrors `lifecycle.rs`'s legal-transition table so a rendered button can never be
  clicked into a rejected call.

### `lib/mandate-gateway.ts` — a second gateway alongside `chain-gateway.ts`, not a merge

Phase 10's `ChainGateway` is checkout-scoped (`createMandate`/`approve`/`queryAllowance`). The
dashboard needed a distinct read path (`getMandate`) and the three lifecycle writes
(`pauseMandate`/`resumeMandate`/`revokeMandate`, all payer-signs-and-submits via
`submitAsInvoker` — same authorization flow as `create_mandate`), plus the same
`approve`/`queryAllowance` primitives reused verbatim for the post-revoke allowance-zero prompt.
Kept as a separate `MandateGateway` interface (not folded into `ChainGateway`) since the two
components' signing lifetimes differ: checkout's gateway is used once per session, the dashboard's
is a long-lived singleton reused across every mandate card and every action.

### `lib/revoke-flow.ts` — "cancel autopay" as its own state machine

Mirrors `checkout-state.ts`'s reducer pattern. Revocation itself is unconditional and immediate the
moment `revoke_mandate` confirms (PLAN.md §10.9) — nothing downstream can make it conditional. What
the reducer sequences *after* that is the lead's decision: `checking-allowance` ->
(`allowance-prompt` if non-zero, straight to `complete` if already zero) -> `zeroing-allowance` (or
`SKIP_ALLOWANCE`) -> `complete`. Declining the prompt is a first-class, fully-supported outcome —
the mandate is already safely cancelled either way. `components/dashboard/cancel-autopay-dialog.tsx`
drives the actual `MandateGateway` calls from `useEffect`s keyed on `state.phase` alone (not every
captured prop), since several of the parent's props are fresh literals every render and the effect
must fire exactly once per phase transition, never re-submit a signed transaction because a
callback's identity changed.

### `lib/failure-reasons.ts` — payment-history's failed-attempt copy

Distinct from `lib/errors.ts`'s checkout-flow copy (which frames the *payer's own* action failing).
Every one of the 24 frozen contract error codes plus the relayer's 3 infra-transient reasons
(`RPC_UNAVAILABLE`/`SEND_FAILED`/`TX_NOT_INCLUDED`, `apps/relayer/src/classify.ts`) gets a
"here's what was tried, here's why we blocked it" sentence — a blocked attempt on this dashboard is
framed as proof the protection worked, not a scary error. The stable machine code is always shown
alongside, small, for support (CLAUDE.md §8).

### `DashboardShell` orchestration

One client component owns wallet connection, per-mandate live reads (`Record<mandateId, ...>`
keyed state, refreshed individually so one mandate's action never reloads the whole list), payment
history, and tab filtering. The five-tab nav (PLAN.md §16.1) filters the same live-read set two
ways: "Upcoming"/"Active" both show `status === "Active"` mandates (different sort — soonest next
charge vs. merchant name), "Paused & ended" shows everything else. A `pause`/`resume` failure
(e.g. the mandate was already revoked in another tab/session underneath the user) both surfaces an
inline error *and* triggers `refreshMandate` in a `finally` block, so the card's controls re-derive
from fresh chain state rather than staying stale — the task's explicit "refresh and explain, don't
just error out" requirement.

### E2E stub wiring

`lib/e2e-stub-fixtures.ts` is the single source of truth for the one fixture mandate id/merchant/
asset shared between `lib/test-stubs.ts`'s stub `MandateGateway` ("chain") and
`e2e/fixtures/mock-api-server.mjs`'s new `/v1/consumer/mandates`/`/v1/consumer/payments` routes
("database") — both halves must agree for the dashboard's discovery-then-verify story to hold
together in a test with no real backend or RPC. The stub gateway also seeds a realistic non-zero
starting allowance (as if Phase 10's checkout `approve` had already run), so
`e2e/dashboard.spec.ts` exercises the actual allowance-to-zero prompt, not just its already-zero
skip path.
