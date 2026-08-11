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

## Phase 12b — Merchant dashboard (`apps/web`)

The merchant dashboard (PLAN.md §16.3: Products, Checkout links, Active mandates, Upcoming/Failed
collections, Payments, Refunds, Developers, Webhooks) is architecturally the opposite of Phases
10-11's consumer checkout/dashboard: those are entirely client-side (browser wallet signs directly
against Soroban RPC, no secret ever exists), while every merchant view is authenticated with a
**merchant API key** that must never reach client-side JavaScript (this phase's lead decision #1).
That constraint drives every layering choice below.

### The API-key boundary: `server-only`, not just convention

`lib/merchant-session.ts` (httpOnly cookie read/write) and `lib/merchant-api.ts` (the typed
`/v1/*` client) both start with `import "server-only"` — the real npm package that makes `next
build` fail outright if any `"use client"` file ever imports either module, transitively or not.
This turns "the key never leaks client-side" from a code-review hope into a build-time guarantee.
`lib/no-secret-leak.test.ts` adds a second, faster proof: it statically scans every Client
Component under `app/merchant/**`/`components/merchant/**` for a *value* import (not a type-only
one, which is erased and harmless — the same distinction `tasks/lessons.md` already documents for
this repo's other server-only-adjacent barrels) of either module, so a violation is caught by
`pnpm test` without waiting for a full `next build`.

The key itself lives only in an httpOnly, `sameSite: "lax"` cookie
(`MERCHANT_API_KEY_COOKIE`) — there is no merchant login system in this MVP (no email/password,
no OAuth); the API key *is* the identity, exactly as `apps/api`'s own auth already models it. A
merchant either creates a new account (`POST /v1/merchants`, unauthenticated bootstrap) or pastes
an existing key back in (`/merchant/connect`'s "Already have an API key" form, which verifies the
key with a real authenticated call before storing it, so a stale/revoked key fails immediately
with a clear error rather than silently breaking every later page).

### Server Components read, Server Actions write

Every `app/merchant/**/page.tsx` (except `connect/page.tsx` itself) is an `async` Server Component
that calls `requireMerchantApiKey()` (`lib/merchant-guard.ts`, redirects to `/merchant/connect` if
no cookie) and then fetches directly from `lib/merchant-api.ts` — no client-side `fetch` ever
carries the `Authorization` header. Every mutation (`lib/merchant-actions.ts`) is a `"use server"`
Server Action following one pattern: read the cookie server-side, validate, call the API, and
return a discriminated `{ ok: true, ... } | { ok: false, error, fieldErrors? }` result for
`useActionState` — `redirect()` is only ever called on the success path, *outside* any try/catch
(Next.js's redirect mechanism throws a special signal that a generic catch would otherwise
swallow).

### The "show a secret exactly once" pattern, and the bug it exposed

`createMerchantAction`/`rotateApiKeyAction`/`registerWebhookEndpointAction` all set a cookie (or
persist a secret) *and* need to keep rendering the current page afterward, so the freshly issued
value can be shown to the merchant exactly once (CLAUDE.md §10) — never a URL, never re-fetchable.
This surfaced a real bug during development: `connect/page.tsx` originally redirected away the
instant a session cookie was present, and Next.js re-renders a route's Server Components as part
of the *same* action response when a Server Action mutates cookies — so `createMerchantAction`'s
cookie write raced the client past the success view before anyone could ever see the key. Fixed by
making `/merchant/connect` the one page that never guards on cookie presence (see its own module
doc); every other page's guard is unaffected since none of them ever need to render a
just-issued-secret success state.

### Reused, not duplicated, business logic

`lib/merchant-mandate-display.ts`'s `toBigintMandate` converts the API's decimal-string mandate
response back into the exact `bigint`-typed shape Phase 11's `lib/mandate-status.ts` already
expects, so "Upcoming collections" and the mandate detail page's period-usage meter reuse
`computeNextEligibleChargeDate`/`computeEffectivePeriodUsage` verbatim (CLAUDE.md §20) rather than
re-deriving the same formulas a second time. `components/dashboard/status-badge.tsx` and
`components/dashboard/empty-state.tsx`/`period-usage-meter.tsx` are reused directly, unchanged,
from the consumer dashboard.

### List endpoints: a documented, scoped backend addition

PLAN.md §14 only specifies single-resource merchant reads (`GET /v1/mandates/:id`, `GET
/v1/charges/:id`) plus one payments list. Rendering PLAN.md §16.3's dashboard views needed six new
merchant-scoped `GET` list endpoints (`/v1/products`, `/v1/checkout-sessions`, `/v1/mandates`,
`/v1/charges`, `/v1/refunds`, `/v1/webhook-deliveries`) — each mirrors an existing single-resource
read's auth/ownership rules exactly, documented in `docs/merchant-api.md`'s scope note. `GET
/v1/mandates` in particular re-reads every listed mandate live on-chain (never the `MandateIndex`
cache alone, CLAUDE.md §2), degrading a single row to its cached status (`live: false`) rather than
failing the whole list if one live read fails.

### E2E: a stateful mock, keyed per-account

`e2e/fixtures/mock-api-server.mjs`'s merchant routes keep a `Map<apiKey, account>` rather than one
shared module-level object — `playwright.config.ts` runs `fullyParallel: true` against one shared
mock-server process for the whole spec file, and an earlier single-`merchant`-variable version
produced real cross-test 401s the first time a second (accessibility) merchant test ran
concurrently with the happy-path test's own API-key rotation step.

## Phase 12c — On-chain event indexer (`apps/relayer/src/indexer`)

### Why this exists

Phase 12a shipped webhook delivery but 4 of the 8 required events (PLAN.md §14, CLAUDE.md §12) had
no producer: `mandate.active`/`mandate.paused`/`mandate.resumed`/`mandate.revoked`. Those contract
calls (`create_mandate`/`pause_mandate`/`resume_mandate`/`revoke_mandate`) are signed and submitted
directly from the payer's wallet (Phase 10/11) — never routed through `apps/api` — so nothing
observed them. The same gap meant `MandateIndex` only ever got created/refreshed when a checkout
flow happened to link one; a payer pausing or revoking out-of-band left the index stale.

### Placement: `apps/relayer`, not a new app

The indexer is architecturally identical in shape to the charge/webhook workers already in
`apps/relayer` (poll -> process -> idempotent DB write) and needs the same infrastructure: a
`ChainGateway`-style read seam, `WebhookDelivery` enqueue, and a `setInterval` scheduler. Standing up
a fifth app for one more poll loop would duplicate all of that. `apps/relayer/src/index.ts` wires
`startIndexerScheduler` alongside the existing charge/webhook schedulers.

### Layering

```text
contracts/mandate-registry/src/events.rs      the 5 lifecycle #[contractevent]s — the schema
        │
packages/contract-client/src/events.ts        decodes rpc.Api.EventResponse -> MandateLifecycleEvent
        │  (./events subpath — never the root barrel, see "browser-safe subpaths" note below)
        ▼
packages/stellar/src/events.ts                fetchMandateLifecycleEvents: RPC access, pagination
        ▼
apps/relayer/src/indexer/
  chain-events-gateway.ts   the injected seam (real RPC / FakeChainEventsGateway in tests)
  cursor.ts                 durable poll-cursor persistence (IndexerCursor, CAS)
  mandate-index-sync.ts     MandateIndex upsert + webhook enqueue, merchant resolution/isolation
  indexer.ts                one tick: fetch -> gap-check -> apply each event -> advance cursor
  scheduler.ts               setInterval loop around indexer.ts
```

`packages/contract-client/package.json` gained a `./events` subpath export (mirroring the existing
`./client`/`./domain` pattern) specifically so `packages/stellar/src/events.ts` never imports from
the package's root barrel — that barrel also re-exports `./deployment-registry.js` (`node:fs`), and
`packages/stellar`'s own root barrel is imported by value from `apps/web` (`lib/mandate-gateway.ts`,
`lib/chain-gateway.ts`). Without the subpath, adding `events.ts` to `packages/stellar/src/index.ts`
broke `next build` outright (`UnhandledSchemeError: Reading from "node:fs"`) — the same failure mode
`tasks/lessons.md` already documents for `contract-client`'s own barrel, recurring one layer up.

### Event decoding (`packages/contract-client/src/events.ts`)

Verified directly against `soroban-sdk-macros-27.0.2`'s `derive_event.rs`, not assumed: a
`#[contractevent]`'s wire topics are `[Symbol(snake_case(struct_name)), ...#[topic] fields in
declaration order]` — every event in `events.rs` topics `mandate_id`, `payer`, `merchant` in that
order, so topics are always `[name, mandate_id, payer, merchant]`. The event's `data` is an `ScvMap`
(the macro's default `data_format`, never overridden) keyed by Rust field name.
`@stellar/stellar-sdk`'s `scValToNative` converts an `ScvMap` straight into a plain object keyed by
the already-decoded field name and an `ScvVec`/topics list into a plain array — no contract spec or
hand-rolled XDR walking needed, just read fields by name. `decodeMandateLifecycleEvent` returns
`undefined` for anything that isn't one of the 5 lifecycle events (including `charge_succeeded`/
`refund_succeeded`, which already have producers and are out of this indexer's scope) and throws
`MandateEventDecodeError` only when a *recognized* lifecycle event's shape doesn't match what
`events.rs` publishes — a genuine ABI drift, not a skip-and-continue condition.
`packages/contract-client/src/events.test.ts` proves this against fixtures built with
`nativeToScVal`/`xdr.ScVal.scvMap` matching the macro's exact output shape, not hand-waved stand-ins.

### Event -> webhook mapping and `mandate_completed`'s special case

```text
mandate_created  -> mandate.active
mandate_paused   -> mandate.paused
mandate_resumed  -> mandate.resumed
mandate_revoked  -> mandate.revoked
mandate_completed -> (no webhook — see below)
```

The charge pipeline (`apps/relayer/src/pipeline.ts`, Phase 12a) already enqueues `mandate.completed`
synchronously in the same DB transaction as the charge that completes the mandate — strictly more
timely than any poll loop, and already tested. `mandate-index-sync.ts`'s `EVENT_TO_WEBHOOK` table has
no entry for `mandate_completed`, so the indexer updates `MandateIndex.status` to `"Completed"` when
it observes that event (chain remains authoritative for status) but never enqueues a second webhook
for it. **The charge pipeline is the sole producer of `mandate.completed`.**
`indexer/mandate-index-sync.test.ts`'s "does not duplicate mandate.completed" test seeds a
pipeline-style random-`eventId` delivery row first, then runs the indexer over the corresponding
on-chain event, and asserts the `mandate.completed` count for that merchant stays at exactly 1.

### Deterministic event id and idempotency (decision #3)

`WebhookDelivery.eventId` for every indexer-produced row is `chain:<rpc event id>`. Soroban RPC's own
event `id` (e.g. `"0016545579823816704-0000000000"`, observed on real testnet — see the real-testnet
proof below) is derived purely from ledger/transaction/operation/event position, never anything
random, so two indexer instances (or one instance reprocessing an already-applied range after a
restart) observing the identical on-chain event always compute the identical `eventId`. The insert
uses `createMany({ skipDuplicates: true })` (`webhook.ts::enqueueDeterministicWebhook`) rather than a
plain `create()` — a duplicate `eventId` is a harmless no-op insert, never a thrown unique-constraint
error that would poison the enclosing transaction (`tasks/lessons.md`'s insert-or-read-existing
note). `MandateIndex`'s own upsert is a single atomic `INSERT ... ON CONFLICT ("mandateId") DO UPDATE
... WHERE "lastIndexedLedger" IS NULL OR "lastIndexedLedger" <= EXCLUDED."lastIndexedLedger"` — chain
wins, and the `WHERE` guard makes an out-of-order/replayed event a safe no-op rather than a
regression. Both a same-event reprocess and two concurrent indexer instances racing an overlapping
range are covered directly by `indexer/indexer.test.ts`/`indexer/mandate-index-sync.test.ts` against
a real Postgres.

### Merchant resolution and isolation (decision #6)

`mandate-index-sync.ts::resolveMerchant` prefers the existing `MandateIndex` row's own `merchantId`
(set once, from verified on-chain data) when one exists; otherwise it resolves by the event's
`merchant` address against `Merchant.walletAddress`. An event whose merchant address matches no
`Merchant` row in this deployment cannot be attributed to anyone — `MandateIndex.merchantId` is a
required FK, so there is nothing valid to create a row against — and is logged and skipped rather
than guessed at. This is also what makes cross-merchant isolation structural rather than a
convention: a webhook can only ever be enqueued for the one merchant an event's own resolved
`merchantId` points to, proven directly (two merchants, one event, only one gets a delivery row) in
`indexer/mandate-index-sync.test.ts`.

### Cold-start asset backfill

`MandateIndex.assetAddress` is a required column, but only `mandate_created` carries the asset in
its event data. A non-creation event (e.g. `mandate_paused`) observed with no existing `MandateIndex`
row for that mandate — a genuine cold-start case, such as the indexer's lookback window starting
after the mandate's creation — triggers exactly one fresh `get_mandate` read (reusing the relayer's
existing `ChainGateway`, no second RPC client) to fill in the real on-chain asset rather than
fabricating a placeholder (decision #4: chain is the only source of truth, including when
backfilling a row for the first time).

### Cursor persistence and retention-gap detection (decisions #1, #2)

A dedicated `IndexerCursor` table (one global row, `prisma/schema.prisma` — see that model's doc
comment), not a field on `MandateIndex`: the poll cursor is a single property of the whole contract's
event stream, while `MandateIndex.lastIndexedLedger` is per-*mandate*. `cursor` is Soroban RPC's own
opaque continuation token (the actual resume position); `lastLedger` is a best-effort human-readable
high-water mark used only for the gap check below, never for resuming pagination.

On the very first run ever (no stored cursor), the indexer starts from `currentLedger -
DEFAULT_INITIAL_LOOKBACK_LEDGERS` (100 ledgers, ~8 minutes at 5s/ledger) — a deliberate scoping
decision: this indexer does not attempt a full historical backfill beyond a small window on cold
start. It exists to keep the index and webhooks current going forward, not to replay months of
history; the lookback and page-size are constructor parameters (`IndexerDeps.initialLookbackLedgers`/
`pageLimit`), not environment variables, since nothing beyond the code's own sane defaults needed
tuning for this phase's scope.

**Retention-gap detection is two independent checks, both throwing the same
`IndexerRetentionGapError`, and neither ever silently skips ahead:**

1. A heuristic match on the `getEvents` call itself throwing an error whose message mentions common
   Soroban RPC wording for an invalid/pruned position (`"oldest ledger"`, `"cursor"`,
   `"start ledger"`, etc.) — best-effort and explicitly documented as such, since this repo's
   contract was deployed only ~2 days before this indexer was built, so the *exact* error text a
   genuinely 7-day-stale cursor produces has not been observed against live infrastructure.
2. A **more robust, response-shape-independent** check: on every successful response, if the RPC's
   own `oldestLedger` has advanced past `storedCursor.lastLedger + 1`, ledgers in between were pruned
   before this indexer could read them, regardless of whether the call itself errored.

Either condition throws before the cursor is advanced, so the next tick fails identically until an
operator intervenes — there is no automatic "skip the gap and continue" path, which is the one thing
decision #1 explicitly forbids. `indexer/indexer.test.ts` proves both paths with a fake gateway that
can either throw on demand or report an arbitrary `oldestLedger`; the true 7-day-stale-RPC-error
scenario itself remains unverified against live infrastructure (a real architectural finding, not a
gap in test coverage — see this phase's final report for the honest caveat).

### Real-testnet proof

`scripts/verify-indexer-testnet.ts` creates a fresh mandate and immediately pauses it (both
payer-signs-and-submits, no token allowance needed — neither call moves funds), then runs the actual
`runIndexerTick` (`createSorobanChainEventsGateway`, real Soroban RPC) against real testnet. Real
result: `mandate_created` (event id `0016545579823816704-0000000000`) and `mandate_paused` (event id
`0016545584118796288-0000000000`) were both decoded and applied in one tick, producing
`MandateIndex.status = "Paused"` and exactly one `mandate.active` + one `mandate.paused`
`WebhookDelivery` row for the correct merchant — see `tasks/todo.md`'s Phase 12c `## Review` entry
for the full transcript (mandate id, both real transaction hashes).
