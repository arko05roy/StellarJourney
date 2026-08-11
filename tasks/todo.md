# Stellar Mandates — Phase Plan

Derived from `PLAN.md` §22 milestones + `CLAUDE.md` §18 implementation sequence.

Rule: contract is policy authority. Every phase ships vertical slice + tests. No phase marked done without commands in §"Gate" executed successfully.

---

## Phase 0 — Repository Foundation

**Goal:** empty monorepo builds green in CI.

- [x] `git init`, `.gitignore`, `.env.example` (vars from CLAUDE.md §16)
- [x] pnpm workspaces + Turborepo (`pnpm-workspace.yaml`, `turbo.json`)
- [x] `packages/config` — shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), ESLint flat config, Prettier
- [x] Scaffold empty workspaces per CLAUDE.md §4: `apps/{web,api,relayer}`, `packages/{contract-client,sdk,shared,ui,stellar,config}`
- [x] Rust workspace `Cargo.toml` + `contracts/mandate-registry` + `contracts/mock-token`
- [x] `docker-compose.yml` — Postgres 16, Redis 7
- [x] Prisma init, `DATABASE_URL` wired
- [x] Typed env module in `packages/config` (Zod, fail-fast at startup)
- [x] GitHub Actions: `pnpm lint/typecheck/build/test` + `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test`
- [x] Doc stubs: `docs/{architecture,contract-invariants,merchant-api,threat-model,demo-script,roadmap}.md`

**Gate:** `pnpm install && pnpm lint && pnpm typecheck && pnpm build` + `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings` all pass in CI.

**Risk:** none. Pure setup.

---

## Phase 1 — Contract Types, Errors, Storage

**Goal:** canonical data model exists before any logic.

- [x] `MandateStatus`, `AmountRule`, `Mandate`, `PaymentReceipt`, `RefundReceipt` (PLAN.md §10.3, §12)
- [x] `Error` enum — all 20 codes from CLAUDE.md §8, stable numeric discriminants (frozen once assigned)
- [x] Storage keys: `Mandate(id)`, `Payment(id)`, `UsedCharge(mandate_id, charge_id)`, `UsedRefund(refund_id)`, `RefundedTotal(payment_id)`
- [x] Storage TTL/bump strategy — persistent for mandates+receipts, decide instance vs persistent explicitly
- [x] `mandate_id` derivation: `hash(network_id, contract_addr, payer, merchant, asset, client_nonce)` (PLAN.md §10.2)
- [x] Checked-arith helpers → `ArithmeticOverflow`

**Gate:** `cargo test --workspace` (type/hash-determinism tests).

**Invariants touched:** none live yet. Error codes become a public contract — changing later breaks backend mapping.

---

## Phase 2 — Mandate Lifecycle (create / pause / resume / revoke)

**Goal:** payer-only state machine, no money movement.

- [x] `create_mandate(input) -> BytesN<32>` — `payer.require_auth()`, validate all bounds (positive amounts, `expires_at > start_at`, `period_seconds > 0`, `max_per_period >= max_per_charge`), reject duplicate id
- [x] `pause_mandate`, `resume_mandate`, `revoke_mandate` — payer auth, legal-transition table only
- [x] `get_mandate` — lazy `Expired` evaluation on read (PLAN.md §10.8), does not persist-write on read path
- [x] Events: `mandate_created`, `mandate_paused`, `mandate_resumed`, `mandate_revoked` (no `mandate_expired` — expiry is computed-only, never a state transition; see decision below)
- [x] Tests: success, wrong-signer rejection per method, resume-from-revoked rejection, revoke-from-completed, pause idempotency (all as explicit rejections — no idempotent no-ops)

**Gate:** `cargo test --workspace`.

**Invariants:** §7 Authorization (payer-only), §7 State (revocation immediate, no merchant approval).

**Decision (resolved):** lazy expiry stays **computed-only** — never written to storage, on
either the read path or any write path. See `docs/contract-invariants.md` Phase 2 section for
the full rationale.

---

## Phase 3 — Fixed Charge Execution

**Goal:** first money movement. Full validation order.

- [x] `charge(mandate_id, charge_id, amount, invoice_hash) -> PaymentReceipt`
- [x] `merchant.require_auth()` — never relayer
- [x] Implement validation order 1–14 exactly per CLAUDE.md §6, in that sequence
- [x] Fixed rule: `amount == fixed` else `AmountExceedsChargeLimit` / `InvalidAmount`
- [x] `min_interval_seconds` check vs `last_charged_at`
- [x] Duplicate `charge_id` → `DuplicateCharge`
- [x] SAC `transfer_from(spender=contract, from=payer, to=merchant, amount)`
- [x] Update accounting **after** transfer only: `successful_charges`, `total_collected`, `current_period_collected`, `last_charged_at`, receipt store, event emit
- [x] `get_payment`
- [x] `charge_succeeded` event with full field set (PLAN.md §11)
- [x] Tests: success, wrong-merchant, before start, after expiry, too soon, duplicate charge id, paused, revoked, wrong amount, insufficient allowance, insufficient balance, transfer-failure rollback

**Gate:** `cargo test --workspace` w/ `mock-token` incl. a panicking/failing token variant for rollback test.

**Invariants:** §7 Amounts (fixed exact), §7 Time (all three), §7 Replay (`charge_id` once), §7 Tokens (merchant receives exactly, contract retains nothing), §6 accounting rollback.

**Stop condition:** if Soroban `transfer_from` failure does not unwind sub-invocation state as assumed → stop, report, do not work around.

---

## Phase 4 — Variable Charge + Period Accounting

**Goal:** capped variable billing, period rollover correct.

- [x] `AmountRule::Variable(max_per_charge)` enforcement (was already generic since Phase 3; confirmed + extended tests)
- [x] `period_index = floor((now - start_at) / period_seconds)`; on index change reset `current_period_collected = 0`, set `current_period_start` to computed boundary (not `now`)
- [x] `max_per_period` remaining-allowance check
- [x] `max_successful_charges` → transition `Completed` + `mandate_completed` event
- [x] Tests: variable success, over per-charge cap, over per-period cap, two charges same period summing to cap, period rollover resets, skipped-period boundary (long gap), charge exactly at boundary second, max count reached → completed → next charge rejected

**Gate:** `cargo test --workspace`.

**Invariants:** §7 Amounts (period total), §7 Time (period reset exactly once per period).

**Explicit test:** boundary at `t = start_at + n*period_seconds` — assert reset happens at `>=`, not `>`.

---

## Phase 5 — Refunds

- [x] `refund(mandate_id, payment_id, amount, refund_id) -> RefundReceipt` — merchant auth
- [x] Cumulative `refunded_total[payment_id]`; `refunded + amount <= payment.amount` else `RefundExceedsPayment`
- [x] `refund_id` replay guard → `DuplicateRefund` (global scope, not per-payment)
- [x] Transfer merchant → payer; accounting only after success
- [x] `refund_succeeded` event
- [x] Decided: refund does **not** decrement `total_collected` / `current_period_collected` /
      `successful_charges`, and does not un-complete a `Completed` mandate — refunds do not
      restore spending headroom (prevents refund-cycle cap bypass). Documented in
      `docs/contract-invariants.md` Phase 5 section.
- [x] Tests: full, partial, partial×2 to exact total, over-refund, duplicate refund id (incl.
      across different payments), refund on revoked/paused/expired/completed mandate (all still
      work), refund unknown payment, refund payment belonging to a different mandate, auth
      (payer/third-party rejected), rollback with real failing transfer + retry, refund of an
      older payment leaving newer charge accounting untouched, event field assertions,
      `get_refund`/`get_refunded_total` reads

**Gate:** `cargo test --workspace` — ran, all green (136 tests: 127 mandate-registry + 9 mock-token).

**Invariants:** §7 Amounts (refund ≤ payment), §7 Replay (`refund_id` once).

---

## Phase 6 — Invariant & Property Tests

**Goal:** prove §7 holds under random action sequences.

- [x] Property harness: random ops `create|charge|pause|resume|revoke|refund|advance_time`
- [x] Assert after every op: all 22 PLAN.md §18 invariants
- [x] Key oracle: `successful_charges == count(stored receipts)`
- [x] Key oracle: `sum(receipts in period) <= max_per_period`
- [x] Key oracle: contract token balance == 0 after every op
- [x] Adversarial: malicious token contract (reentrant `transfer_from`, lying return, balance drain)
- [x] Write `docs/contract-invariants.md` — every invariant → the test that proves it

**Gate:** `cargo test --workspace` incl. property suite.

**This phase is the security bar. Do not skip to Phase 7 with failures.**

---

## Phase 7 — Deploy + Contract Client

- [x] `scripts/deploy-testnet.ts` — build, optimize, deploy, record contract id
- [x] Deployment registry JSON keyed by network
- [x] `packages/contract-client` — generated bindings + typed wrapper (i128 ↔ bigint, never `number`)
- [x] `packages/stellar` — tx builder, simulation helper, auth-entry assembly, error-code → typed error decoder
- [x] `packages/shared` — Zod schemas, decimal-string ↔ base-unit conversion (reject over-precision), shared mandate types
- [x] `scripts/create-demo-mandate.ts` — creates + charges a mandate on testnet

**Gate:** demo script executes real testnet mandate create + charge; tx hashes recorded.

**Stop condition:** testnet behavior ≠ local sandbox → report diff, do not paper over.

---

## Phase 8 — Merchant API

- [ ] Prisma schema: User, Merchant, Product, CheckoutSession, MandateIndex, ChargeRequest, Payment, WebhookDelivery, IdempotencyKey (PLAN.md §13)
- [ ] Unique constraints: `(merchantId, idempotencyKey)`, `chargeId`, `paymentId`, `refundId`, webhook `eventId`
- [ ] API key issue/hash/rotate; shown once; `API_KEY_HASH_SECRET`
- [ ] Endpoints (PLAN.md §14) — every input Zod-validated
- [ ] Idempotency middleware: store merchant+key+request hash+status+body; different hash w/ same key → 409
- [ ] ChargeRequest state machine w/ DB transactions (CLAUDE.md §17)
- [ ] Contract-error → API-error mapping, original code preserved, no generic `INTERNAL_ERROR`
- [ ] Rate limits on key-issuance + charge endpoints
- [ ] Tests: auth, validation, idempotency replay + conflict, state transitions

**Gate:** `pnpm test` (API integration suite w/ Docker Postgres).

**Rule:** API never writes `Payment` from its own state — only from confirmed on-chain result.

---

## Phase 9 — Relayer

- [ ] BullMQ worker; deterministic job id = `chargeRequest.id`
- [ ] Pipeline: load fresh on-chain mandate → build invocation → simulate → verify merchant/amount/asset/charge_id match request → submit → poll final status → persist tx hash + ledger
- [ ] Failure classifier: permanent (revoked, expired, duplicate, over-limit, too soon, max count) vs transient (RPC, timeout, not-included, balance/allowance per merchant policy)
- [ ] Retry schedule: +6h, +24h, +72h → `permanently_failed`
- [ ] Concurrency test: two workers, same job → at most one success
- [ ] Event reconciliation: `charge_succeeded` → `Payment` row
- [ ] Tests: classification table, duplicate job, stale-simulation handling

**Gate:** `pnpm test` + one scheduled payment executes end-to-end on testnet.

**Invariant:** relayer key has zero spending authority. Assert in test that relayer-signed charge with altered amount fails.

---

## Phase 10 — Consumer Checkout

- [ ] Next.js App Router, Tailwind, shadcn/ui
- [ ] Stellar Wallets Kit connect
- [ ] Checkout page: merchant identity, product, **all terms visible, none collapsed** (CLAUDE.md §13)
- [ ] Max-exposure calculator: `min(max_per_charge × max_charges, max_per_period × periods_until_expiry)` — show number
- [ ] Two-step sign: `create_mandate` → bounded `approve` (remaining theoretical max + explicit fee headroom). Never unlimited.
- [ ] Allowance-change flow: zero → confirm → set new
- [ ] Confirmation screen: mandate id, next eligible charge date

**Gate:** `pnpm test` + Playwright happy path.

---

## Phase 11 — Consumer Dashboard

- [ ] Nav: Upcoming / Active / History / Paused & Ended / Settings
- [ ] Mandate card: merchant, asset, amount or max, frequency, next eligible date, period usage, expiry, status
- [ ] Pause / Resume / **Cancel autopay** (revoke) + allowance-to-zero prompt
- [ ] Payment history + failed attempts with human-readable reason
- [ ] Read from contract state, not DB, for status display

**Gate:** `pnpm test`, `pnpm test:e2e`. New user completes full flow with zero CLI.

---

## Phase 12 — Merchant Dashboard + Webhooks + SDK

- [ ] Dashboard: products, checkout links, mandates, upcoming, failed, payments, refunds, developers, webhooks
- [ ] Webhook delivery worker: HMAC SHA-256, timestamp, event id, signature version, retry count header
- [ ] Delivery state machine: pending → delivering → delivered | retry_scheduled → dead_letter
- [ ] Stable event id across retries
- [ ] All 8 events (CLAUDE.md §12)
- [ ] `packages/sdk`: `checkoutSessions.create`, `charges.create`, `payments.refunds.create`, typed error codes, `verifyWebhook` helper
- [ ] Every SDK method gets a working example in `docs/merchant-api.md`
- [ ] Tests: signature verify, retry backoff, duplicate event handling, secret never in payload

**Gate:** `pnpm test`; sample merchant app receives `payment.succeeded`.

---

## Phase 13 — End-to-End Test

Single Playwright test covering the CLAUDE.md §14 chain:

```
merchant product → checkout session → wallet auth → mandate creation
→ token approval → charge request → relayer execution → webhook
→ consumer payment history → revocation → later charge rejected
```

**Gate:** `pnpm test:e2e` green against testnet or local Soroban.

---

## Phase 14 — Security Hardening

- [ ] Write `docs/threat-model.md` — all 9 threats (PLAN.md §19) → mitigation → proving test
- [ ] Adversarial suite (PLAN.md §20.5): relayer alters amount, merchant alters asset, charge-id reuse, concurrent workers, charge-vs-revoke race, period-boundary race, stale simulation
- [ ] Secret audit: no keys in source, no secrets logged, testnet/local key separation
- [ ] Structured logs with `mandateId/chargeId/merchantId/txHash/requestId`; redaction test
- [ ] Observability counters (PLAN.md §21)
- [ ] Rate limits verified under load

**Gate:** zero open critical/high in internal checklist. Full command set from CLAUDE.md §15.

---

## Phase 15 — Demo Polish

- [ ] `scripts/seed-demo.ts` — merchant, consumer, fixed plan, variable plan
- [ ] Transaction timeline UI
- [ ] Scripted demo scenes (PLAN.md §23): success → over-limit rejection → revocation → post-revoke rejection
- [ ] `docs/demo-script.md` + architecture diagram
- [ ] `README.md` one documented command sequence from clean env

**Gate:** clean-machine run reproduces full demo.

---

## Cross-Cutting Rules (every phase)

- Money: integer base units on-chain, decimal strings in API, bigint in TS. Zero floats.
- Time: UTC, Unix seconds on-chain, ISO 8601 in API.
- Tests land in the same change as the code.
- Docs updated when behavior changes (CLAUDE.md §21).
- Never claim a command passed unless executed.

## Deferred (record in `docs/roadmap.md`, do not build)

Pre-debit notice enforcement on-chain, usage billing, passkeys, path payments, anchors, x402/MPP, multi-merchant mandates, governance, tokens, mainnet.

Note: PLAN.md §4 MVP example B mentions "pre-debit notice required 24h". MVP treats this as off-chain merchant notification only — not a contract-enforced constraint. Contract-enforced version is Phase 2 roadmap.

---

## Review

_(fill after each phase: what changed, commands run, what remains unverified)_

### Phase 0 — Repository Foundation (done)

**What changed:** full monorepo scaffold — pnpm workspaces (`apps/{web,api,relayer}`,
`packages/{config,contract-client,sdk,shared,ui,stellar}`), Turborepo, root `package.json`
(name `paymap`, pnpm@10.12.1 pinned), `.gitignore`, `.env.example`. `packages/config` ships
`tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`exactOptionalPropertyTypes`, `isolatedModules`, `moduleResolution: bundler`, target ES2022),
an ESLint 9 flat config (`typescript-eslint` recommended + `no-explicit-any: error`), a
Prettier config, and a Zod-backed typed env module (`loadEnv`/`getEnv`, fails fast listing
every missing/invalid var, lazily memoized — 4 real Vitest tests). Each workspace has a
minimal placeholder that builds and typechecks; `apps/web` is a hand-scaffolded Next.js 15
App Router + Tailwind app (shadcn deferred to Phase 10). Rust workspace: root `Cargo.toml`
(`soroban-sdk = "27"`, resolver 2, the exact release profiles specified) plus
`contracts/{mandate-registry,mock-token}`, each `#![no_std]`, `cdylib+rlib`, one passing unit
test (`ping` via `env.register` / generated client). `docker-compose.yml` (Postgres 16, Redis
7, healthchecks, named volumes). `prisma/schema.prisma` — datasource + generator only, no
models (Phase 8). `.github/workflows/ci.yml` — `node` job (install/lint/typecheck/build/test)
and `rust` job (fmt/clippy/test/wasm32v1-none release build). Six `docs/*.md` stubs incl.
`roadmap.md` recording the deferred items from this file's bottom section.

**Commands run (all passed):**
```
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e   (placeholder no-ops except apps/web, which runs a real `next build`)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (2 real tests, both pass)
cargo build --workspace --release --target wasm32v1-none   (produces both .wasm artifacts)
docker compose config               (validated, Docker not actually started)
prisma validate --schema prisma/schema.prisma   (valid; DATABASE_URL supplied inline, not read from a live DB)
```

**Deviations from spec:** none material. Chose plain `tsc` over `tsup` for `apps/api` /
`apps/relayer` builds (simplicity — no bundling need yet, spec allowed either). Hoisted common
dev tooling (typescript, eslint, prettier, vitest, turbo, prisma CLI, @types/node) to the root
`package.json` rather than duplicating in every workspace; workspace-local `eslint.config.mjs`
files re-export `@paymap/config/eslint`. Made all 9 `CLAUDE.md §16` env vars required
(non-empty) in the Zod schema, including `MANDATE_CONTRACT_ID` / `RELAYER_SECRET_KEY` /
`WEBHOOK_ENCRYPTION_KEY` / `API_KEY_HASH_SECRET`, since the module is lazy (`getEnv()`) and
never called at import time — this is what makes the fail-fast behavior meaningful and
doesn't block any Phase 0 build/typecheck step.

**Unverified / left for later phases:** CI has not been run on GitHub Actions itself (only
reproduced locally); Postgres/Redis containers were validated via `docker compose config`
only, not actually started end-to-end; `prisma generate` was never run (no models exist yet,
nothing consumes `@prisma/client`).

### Phase 1 — Contract Types, Errors, Storage (done)

**What changed:** split `contracts/mandate-registry/src/lib.rs` into modules: `types.rs`
(`MandateStatus`, `AmountRule`, `Mandate`, `PaymentReceipt`, `RefundReceipt`, `MandateInput`,
all `#[contracttype]`, fields/order per PLAN.md §10.3/§12), `error.rs` (`Error`, `#[contracterror]`,
frozen `#[repr(u32)]` 1..20 exactly per CLAUDE.md §8, doc comment marks it public ABI), `storage.rs`
(`DataKey` enum + typed helpers `get_mandate/set_mandate/get_payment/set_payment/
has_used_charge/mark_charge_used/has_used_refund/mark_refund_used/get_refunded_total/
set_refunded_total`, all persistent storage, `PERSISTENT_TTL_THRESHOLD = 17_280` ledgers (~1
day), `PERSISTENT_TTL_EXTEND_TO = 518_400` ledgers (~30 days), every write bumps TTL), `id.rs`
(`derive_mandate_id`, `derive_payment_id` — sha256 over an explicit `Vec<Val>` XDR preimage,
`network_id()` + `current_contract_address()` bound in), `math.rs` (5 checked-arithmetic helpers
returning `Error::ArithmeticOverflow`). `lib.rs` now just declares modules + the unchanged
Phase-0 `ping` entrypoint. All new logic covered in `src/test.rs` (9 tests): frozen error
discriminants (table-driven), mandate_id/payment_id determinism + input-sensitivity, storage
round-trip (write→read + absent-key-reads-none) for `Mandate` and `PaymentReceipt`, replay-guard
isolation (mark-used + no cross-pair collision) for both charge and refund guards,
refunded-total default-zero round-trip, and checked-math boundary tests for all 5 helpers.
Also fixed a pre-existing (Phase 0) `pnpm lint` failure unrelated to the contract: added
`**/next-env.d.ts` to the shared ESLint ignore list in `packages/config/eslint.config.mjs` —
Next.js's autogenerated file (which says "this file should not be edited") was tripping
`@typescript-eslint/triple-slash-reference`.

**Deviation (flagged, not silent):** PLAN.md §10.3 sketches `AmountRule::Variable { max_per_charge:
i128 }` as a named-field enum variant. `soroban-sdk` 27's `#[contracttype]` macro rejects named
enum fields outright (compiler error: `enum variant Variable has unsupported named fields`,
traced to `soroban-sdk-macros-27.0.2/src/derive_enum.rs:65`; only unit/tuple variants are
supported). Changed to `Variable(i128)` — same single value, positional instead of named, no
semantic change. Documented in `types.rs` and `docs/contract-invariants.md`.

**Judgment call:** `MandateInput.client_nonce` is typed `BytesN<32>` (PLAN.md doesn't specify a
type). Chosen for consistency with the other hash-sized fields (`metadata_hash`, `invoice_hash`,
all mandate/payment ids) and to keep the checkout flow's collision-resistance argument simple —
a full 32-byte client-generated value rather than a narrower counter.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (9 new Phase 1 tests + 2 carried-over ping tests, all pass)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```

**Unverified / left for later phases:** no lifecycle or charge logic exists yet (Phase 2/3), so
none of the CLAUDE.md §7 authorization/amount/time invariants are exercised by real business
logic yet — only the storage/id/math primitives they'll be built on. `docs/contract-invariants.md`
Phase 1 section is factual record only; the full invariant→test mapping is still Phase 6.

### Phase 2 — Mandate Lifecycle (done)

**What changed:** two new modules — `lifecycle.rs` (`create_mandate`, `pause_mandate`,
`resume_mandate`, `revoke_mandate`, `get_mandate`, plus the private `effective_status` and
`validate_input` helpers) and `events.rs` (`MandateCreated`, `MandatePaused`, `MandateResumed`,
`MandateRevoked`, all `#[contractevent]`). `lib.rs` now exposes the five lifecycle methods as
thin `#[contractimpl]` wrappers around `lifecycle.rs`. `error.rs` gains three new frozen codes
(21 `InvalidMandateInput`, 22 `DuplicateMandate`, 23 `InvalidStateTransition`) appended after the
Phase 1 frozen 1–20 block, per the lead's decision. No money movement; every write goes through
the existing `storage.rs` helpers; no new arithmetic was needed (Phase 2 only compares/copies
values, so `math.rs` is untouched). `docs/contract-invariants.md` gained a full Phase 2 section:
the legal state-transition table, the new error codes, the `max_successful_charges == 0` =
unlimited rule, the computed-only-expiry decision, and the always-permitted-even-when-expired
revoke rule with rationale.

Tests landed in a new `test_lifecycle.rs` module (65 tests total in the crate now, 56 of them
new): success paths for all 5 methods; `create_mandate` input-bound rejections (one test per
bound, both zero and negative amounts); duplicate-id rejection; every legal and illegal state
transition per the table, including `Completed`-source rejections constructed by writing
directly into storage (bypassing `create_mandate`, since Phase 2 has no code path that can ever
produce `Completed` — that's Phase 3/4's `charge` completing the mandate); expiry tests proving
`get_mandate` doesn't mutate storage and that a `Revoked`/`Completed` mandate's terminal status
survives past `expires_at`; event-field assertions for all 4 events plus a "rejected call emits
no event" test; and an `env.auths()` inspection proving `create_mandate` genuinely required the
payer's authorization (not just "some" authorization).

**Authorization proof method:** every wrong-signer test uses `env.mock_auths`/`MockAuth` with
the auth mocked for the *wrong* address (merchant, a random third party standing in for "the
relayer" — there's no on-chain relayer identity to mock, it has zero special authority per
CLAUDE.md §11) and `#[should_panic]`, so the test fails specifically because the payer's
`require_auth()` finds no matching entry — never `mock_all_auths`, which would hide a missing
auth check entirely.

**Judgment calls / deviations (flagged):**
- Spec's example error names (`InvalidMandateInput`/`DuplicateMandate`/`InvalidStateTransition`)
  were adopted as-is at 21/22/23. `InvalidMandateInput` is a deliberate catch-all for every
  `create_mandate` bound except non-positive amounts (which reuses the existing `InvalidAmount`
  since it already existed and fits exactly) — CLAUDE.md's "no generic errors" principle is about
  not collapsing genuinely different failure classes into `INTERNAL_ERROR`; a single input-
  validation-failed code for a batch of mutually-exclusive-at-call-time construction bounds
  (checked in one linear pass before any state exists) is a reasonable granularity, not a
  regression to a generic bucket.
- `min_interval_seconds` and `max_successful_charges` are validated as documented in the task
  brief: effectively unconstrained (0 is legal for both, with different meanings — "no
  constraint" vs. "unlimited").
- Wrong-signer "relayer" tests use a freshly generated `Address` rather than a distinguished
  relayer identity, since the contract has no concept of a relayer address at all (by design —
  CLAUDE.md §11: the relayer has zero spending or lifecycle authority). This is the correct
  on-chain reflection of that invariant, not a shortcut.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (65 mandate-registry tests + 1 mock-token test, all pass)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```

**Unverified / left for later phases:** no charge/refund logic exists yet, so `Completed` can
only be reached in tests via direct storage writes, never through the public API — that becomes
real once Phase 3/4 land. The full CLAUDE.md §7 invariant→test mapping is still Phase 6; this
phase's `docs/contract-invariants.md` section is scoped to what Phase 2 itself introduced.

### Phase 3 — Fixed Charge Execution (done)

**What changed:** new `charge.rs` module (`charge`, `get_payment`) implementing CLAUDE.md §6's
14-step validation order exactly, reusing Phase 2's `lifecycle::effective_status` (now
`pub(crate)`) for the computed-expiry-aware status check at step 2. `AmountRule::Fixed` is fully
enforced (`amount == fixed`, both directions — a smaller amount is a violation too);
`AmountRule::Variable`'s per-charge cap is enforced by the same generic match arm per the lead
decision, while `max_per_period`/period rollover (steps 11–12) are explicit documented no-ops
reserved for Phase 4 at the correct ordinal position. Token interaction uses
`soroban_sdk::token::TokenClient`: `allowance`/`balance` as advisory pre-flight checks (steps
13–14, typed errors instead of an opaque trap), then `transfer_from(&contract_address,
&mandate.payer, &mandate.merchant, &amount)` — the mandate contract is the spender, funds move
payer→merchant directly, the contract is never `from`/`to`. Accounting
(`successful_charges`/`total_collected`/`current_period_collected`/`last_charged_at`), the
`UsedCharge` guard, the `PaymentReceipt`, and the new `ChargeSucceeded` event (`events.rs`, full
PLAN.md §11 field set, `mandate_id`/`payer`/`merchant` topics matching the Phase 2 event
convention) are all written strictly after the transfer succeeds. `math.rs` gained
`checked_add_u32` for the `successful_charges` counter. No new error codes were needed — all of
Phase 1's frozen 1–20 already cover every Phase 3 failure mode.

`contracts/mock-token` went from a Phase-0 `ping`-only placeholder to a real minimal SEP-41/SAC-
shaped contract: `mint` (test-only, no auth check), `balance`, `approve`, `allowance`, `transfer`,
`transfer_from` (SAC-exact signatures on the four `TokenClient`-invoked methods), plus a
test-only `set_fail_transfers(bool)` failure-injection switch used to prove the rollback
invariant against a real trap. Documented in the module doc as never-to-deploy. 7 of its own unit
tests cover mint/balance, approve/allowance, transfer_from's allowance-decrement-plus-balance-move
happy path, insufficient-allowance/insufficient-balance panics, and the failure-injection panic.
`mandate-registry`'s `Cargo.toml` gained a path dev-dependency on `mock-token` (test-only, never a
runtime dependency of the deployed contract).

35 new tests landed in `test_charge.rs` (93 total in the crate now, plus mock-token's own 7):
happy-path full accounting/balance/allowance/receipt/event assertions; merchant-auth-recorded
proof (`env.auths()` inspection, mirroring Phase 2's pattern); one rejection test per specific
error code (nonexistent, paused, revoked, completed-via-direct-storage-write, before-start,
zero/negative amount, over/under the fixed amount, too-soon, max-count-reached, insufficient
allowance, insufficient balance); duplicate-charge_id-after-success (which also proves step 6
precedes step 9 — retried immediately, well within `min_interval`, and still gets
`DuplicateCharge` not `ChargeTooSoon`); a different-charge_id-succeeds-subject-to-interval test;
two wrong-signer `#[should_panic]` tests (payer, and a fresh address standing in for the
relayer — no on-chain relayer identity exists to mock, matching the Phase 2 precedent); the
redirection test described above; two boundary tests (exactly at `start_at` succeeds, exactly at
`min_interval` succeeds via `>=`); two bonus `Variable`-rule tests (success at the cap, rejection
one unit over) since the per-charge-cap logic is already generic; and a `get_payment`
not-found test.

**Rollback test — result, not assumption:** `charge_transfer_failure_rolls_back_and_allows_retry_with_same_charge_id`
sets `mock-token`'s `set_fail_transfers(true)`, calls `charge` wrapped in
`std::panic::catch_unwind` (a small `expect_panic` helper that also silences the panic hook's
stderr output), and after the confirmed panic asserts via direct storage reads
(`env.as_contract(&contract_id, || storage::...)`) that `successful_charges`,
`total_collected`, `current_period_collected` are all still `0`, `last_charged_at` is still
`None`, `get_payment` returns `PaymentNotFound`, and `has_used_charge` is `false`. It then flips
`set_fail_transfers(false)` and retries the identical `charge_id`, which succeeds — proving the
replay guard was never consumed by the failed attempt. This ran and passed; the rollback
behavior was verified, not assumed.

**Judgment calls / deviations (flagged):**
- Step 4 (`now < expires_at` → `MandateExpired`) is, in almost every reachable case, already
  covered by step 2's `effective_status` check (an `Active`/`Paused` mandate past `expires_at`
  computes straight to `Expired` there). Implemented anyway, at its own ordinal position, as
  defense-in-depth per CLAUDE.md §6's literal step list — documented in `charge.rs` and
  `docs/contract-invariants.md` as intentionally redundant, not new logic.
- `period_index` in the `ChargeSucceeded` event is computed straight from `mandate.start_at`
  (`floor((now - start_at) / period_seconds)`, PLAN.md §10.7's formula) rather than from
  `current_period_start`, since Phase 3 never recomputes the latter. Informational only — no
  enforcement depends on it yet.
- `mock-token`'s `approve`/`transfer`/`transfer_from` all call `.require_auth()` on the relevant
  party even though `mint` deliberately does not — matches real SEP-41 semantics for the methods
  that matter to the invariants under test (bounded allowance, spender authorization) while
  keeping the test-fixture-seeding path (`mint`) simple. Both are documented in the module doc.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (93 mandate-registry + 7 mock-token tests, all pass)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```

**Unverified / left for later phases:** `max_per_period` enforcement and billing-period rollover
are Phase 4 scope, not exercised by any Phase 3 test beyond confirming `current_period_collected`
accumulates correctly with no cap applied yet. `refund` doesn't exist until Phase 5. The full
CLAUDE.md §7 invariant→test mapping remains Phase 6's property-test suite.

### Phase 4 — Variable Charge + Billing-Period Accounting (done)

**What changed:** filled in `charge.rs`'s two Phase-3 no-op placeholders (validation steps 11-12)
in place, without reordering anything: step 11 computes `period_index = floor((now - start_at) /
period_seconds)` and the boundary `computed_period_start = start_at + period_index *
period_seconds` (new `math::checked_mul_u64` helper), then derives the *effective*
`current_period_collected` for this charge by comparing `computed_period_start` directly against
the stored `mandate.current_period_start` — chosen over deriving a stored index from
`current_period_start`, since the boundary is the one value the `Mandate` actually persists (see
`docs/contract-invariants.md`'s Phase 4 section for the full reasoning). A mismatch means a full
reset (effective collected = 0); a match means the stored total still applies. Step 12 checks
`effective_collected + amount <= max_per_period` (checked add) else `AmountExceedsPeriodLimit`.
Both the effective period start and effective period total are computed before any token call but
written to `mandate.current_period_start`/`current_period_collected` only in the existing
post-transfer accounting block — no new write path, preserving the Phase 3 rollback guarantee
untouched. Added the completion transition immediately after the accounting increments: if
`max_successful_charges != 0` and the just-incremented `successful_charges` equals it, `status`
flips to `Completed` and a new `MandateCompleted` event (`events.rs`) publishes right after
`ChargeSucceeded`, both inside the same atomic block. `ChargeSucceeded`'s `period_index` field now
carries the authoritative step-11 value instead of Phase 3's `start_at`-only placeholder.

10 new tests landed in a new `test_period.rs` module (103 total in the crate now, plus
mock-token's own 7): two-charges-
summing-to-cap-then-third-rejected; a single first-in-period charge exceeding the cap via a
direct-storage-bypassed mandate (proving step 12 is independent of step 8, since
`create_mandate` can never itself produce `max_per_period < per-charge cap`); rollover reset with
an explicit assertion that `current_period_start` is the computed boundary and *not* `now`; the
required boundary test (one second before a boundary still resolves to the old period and hits
the cap; exactly at the boundary resolves to the new period and succeeds); a 5-period skip
landing on the correct far-forward boundary (not `start_at + 1*period`); full completion
chain (reach cap → `Completed` status → `mandate_completed` + `charge_succeeded` events in order →
next charge rejected with `MandateCompleted`) plus its converse (`max_successful_charges == 0`
charges past an arbitrary count while staying `Active`); a defense-in-depth test proving step 10's
`ChargeCountExceeded` still fires for a bypassed `successful_charges >= max` + `status: Active`
storage state that the public API can never produce; the required min-interval/rollover
interaction test (a rollover cannot bypass the interval check); and the required rollback test —
a charge that would have rolled the period over, with the mock token's failure-injection forcing a
real trap, followed by a byte-for-byte storage comparison proving `current_period_start` /
`current_period_collected` (and every other field) are untouched, then a successful retry that
genuinely rolls over. Every successful-charge assertion in the new file also checks the contract's
own token balance is `0` (CLAUDE.md §7 Tokens spot-check).

**Rollback-with-rollover test — result, not assumption:**
`test_period::rollover_reverts_on_failed_transfer_leaves_period_state_unchanged` forces
`mock-token`'s `set_fail_transfers(true)` for a charge that would have rolled the mandate from
period 0 to period 1, catches the resulting panic with `std::panic::catch_unwind`, and asserts the
whole `Mandate` struct read back from storage is `==` to a copy saved immediately before the
attempt. This ran and passed (see the gate output below) — the "no separate write path" decision
was verified against a genuine failing transfer, not assumed from the code alone.

**Deviation (unavoidable, correctly handled, not silent):** implementing completion surfaced a
consequence the lead's brief didn't anticipate: once `successful_charges` reaches a non-zero
`max_successful_charges`, the mandate completes *in the same charge that reached the cap*, so any
following charge attempt now hits step 2's stored-`Completed` check before step 10's
`ChargeCountExceeded` is ever reached. This makes the Phase 3 test
`test_charge::charge_max_successful_charges_reached_rejected` — written when Phase 3 had no
completion logic at all, so the second charge attempt used to hit step 10 directly — assert the
wrong error. Updated its expectation from `ChargeCountExceeded` to `MandateCompleted` with an
explanatory comment, and added a new bypass-based test
(`test_period::charge_count_exceeded_still_enforced_via_bypassed_active_state`) so step 10 itself
still has direct coverage rather than becoming silently untested. No invariant was weakened by
this — `ChargeCountExceeded` remains a correct defense-in-depth error for a state the public API
can no longer reach through normal use, which is exactly what completion is supposed to guarantee.

**Judgment call:** chose direct current_period_start-boundary comparison over deriving a stored
period index from `current_period_start / period_seconds`. Both are equivalent given
`period_seconds`'s immutability post-creation; the boundary comparison needs no assumption about
how `current_period_start` was produced and matches what the struct actually persists. Documented
in `charge.rs`'s module doc and `docs/contract-invariants.md`.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (103 mandate-registry + 7 mock-token tests, all pass)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```

**Unverified / left for later phases:** `refund` doesn't exist until Phase 5, so refund
interactions with period/completion accounting are untested. The full CLAUDE.md §7
invariant→test mapping remains Phase 6's property-test suite. No adversarial/malicious-token
property testing beyond the existing single-failure-injection mock.

### Phase 5 — Refunds (done)

**What changed:** new `refund.rs` module (`refund`, `get_refund`, `get_refunded_total`)
implementing the validation order specified by the lead exactly: mandate exists (no status
check) → payment exists → payment belongs to `mandate_id` → `mandate.merchant.require_auth()` →
`refund_id` unused (global scope) → `amount > 0` → cumulative refund ≤ payment amount (checked
add) → merchant balance sufficient (advisory) → `TokenClient::transfer(from = merchant, to =
payer, amount)` (never `transfer_from` — no allowance involved, merchant authorizes directly) →
post-transfer: `RefundedTotal` write, `UsedRefund` mark, `RefundReceipt` store, `refund_succeeded`
event. The payer/merchant/asset used for the transfer and the receipt come from the stored
`PaymentReceipt`, never the mandate or call arguments. Per the lead's decision, the `Mandate`
record itself is never written by `refund` — no headroom (`total_collected`,
`current_period_collected`, `successful_charges`, `Completed` status) is ever restored by a
refund; `refund.rs`'s module doc documents the anti-bypass rationale (charge→refund→charge
looping to exceed period caps in real economic terms).

`storage.rs` gained a `DataKey::Refund(refund_id)` key plus `get_refund`/`set_refund` helpers
(persistent, same TTL policy as everything else). `events.rs` gained `RefundSucceeded` (full
PLAN.md §11/§12-style field set: `refund_id`, `payment_id`, `mandate_id`, `payer`, `merchant`,
`asset`, `amount`, `refunded_total_after`, `timestamp`). One new error code,
`RefundNotFound = 24` — genuinely needed since `DuplicateRefund` (19) means the *opposite* thing
(already-used, not not-found) and reusing it would misreport one deterministic failure as
another; error 16 `InsufficientBalance`'s doc comment was broadened (not renumbered) to note it
now also covers the merchant's balance in `refund`, same advisory role as in `charge`. `lib.rs`
gained three new thin entrypoints (`refund`, `get_refund`, `get_refunded_total`) and the new
module/test-module declarations.

**Mock-token fix (test-fixture only, not a contract behavior change):** `mock-token`'s `transfer`
function did not consult the `set_fail_transfers` flag at all — only `transfer_from` did, since no
caller in the codebase used plain `transfer` through the generic `TokenClient` before this phase.
Updated `mock-token::transfer` to honor the flag identically to `transfer_from`, so the refund
rollback test can force a genuine trap the same way the charge rollback test does. Added direct
mock-token test coverage for both the new `transfer` happy path and its failure-injection path (2
new tests, 9 total in that crate now).

29 new tests landed in a new `test_refund.rs` module (127 total in `mandate-registry` now, plus
mock-token's own 9): full/partial refund success with balance assertions (payer restored,
merchant debited, contract holds nothing); two partials summing to the exact payment amount both
succeeding then a third of any positive amount rejected; single over-refund rejected; duplicate
`refund_id` rejected both with a different amount against the *same* payment and against a
*completely different* payment under the same mandate (proving the global, not per-payment,
uniqueness scope); zero/negative amount rejected; unknown `payment_id` and unknown `mandate_id`
rejected; a payment that belongs to a *different* mandate rejected with `PaymentNotFound`;
wrong-signer rejections for both the payer and a random third party (`env.mock_auths`, never
`mock_all_auths`); the four required state-independence tests (revoked/paused/expired/completed,
each charges once then transitions state before refunding); the two required headroom tests
(period-cap-then-refund-then-still-capped, and complete-via-max-charges-then-refund-then-still-
completed-with-unchanged-counters); the rollback test (see below); refund of an older payment
under a mandate with two charges, proving the newer payment's own `RefundedTotal` and receipt are
untouched and mandate-level totals still reflect both original charges; full event-field
assertion; and `get_refund`/`get_refunded_total` not-found/default-zero reads.

**Authorization — two-level auth tree, verified via a real second `require_auth()` call, not
assumed:** a refund's merchant authorization spans two points in the call graph — the top-level
`refund` invocation itself, and the nested `TokenClient::transfer` call inside the token contract
(`from.require_auth()` there, `from == merchant`). `refund_as` in `test_refund.rs` builds a
two-level `MockAuthInvoke` tree (the `refund` call as root, the token `transfer` call as its
`sub_invokes` entry) mirroring exactly what a real merchant wallet would sign for one transaction.
This was necessary for the tests to compile/pass at all — an earlier attempt with only the
top-level auth entry would have failed the nested `transfer`'s own `require_auth()` check, which
is exactly the confirmation that both auth points are real and independently enforced.

**`TokenClient::transfer` signature — verified against the vendored SDK source, per
`tasks/lessons.md`'s existing guidance not to assume it:** `soroban-sdk-27.0.2/src/token.rs`
defines `fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128)` — `to` is
`MuxedAddress`, not `Address` (this project's own lessons file already flagged this exact gap
before any caller existed). `refund.rs` calls `token.transfer(&payment.merchant,
MuxedAddress::from(&payment.payer), &amount)`. Confirmed via the vendored
`muxed_address.rs` source that `MuxedAddress::from(&Address)` wraps a non-multiplexed address as
the identical underlying `AddressObject` value an `Address`-typed parameter expects — verified
empirically too, since `mock-token`'s own `transfer` still declares `to: Address` (SDK-signature-
simplified, documented as such since Phase 3) and every refund test passed against it unmodified.

**Rollback test — result, not assumption:**
`refund_transfer_failure_rolls_back_and_allows_retry_with_same_refund_id` forced
`mock-token::set_fail_transfers(true)`, called `refund` wrapped in `std::panic::catch_unwind`,
and asserted via direct storage reads that `RefundedTotal` was still `0`, no `RefundReceipt`
existed (`get_refund` → `RefundNotFound`), and the `refund_id` was not marked used — then flipped
the token back to working and retried the identical `refund_id`, which succeeded. This ran and
passed; see the gate output below.

**Deviation (flagged, not silent):** added error 24 (`RefundNotFound`) beyond the frozen 1–23
block. The brief said "append at 24+ only if genuinely needed" — this was: `get_refund` needs a
distinct not-found signal, and every existing code either means something else entirely
(`DuplicateRefund`) or belongs to a different resource (`PaymentNotFound`, `MandateNotFound`).
Also made a small non-contract fix to the test-only `mock-token` crate (`transfer` now honors
`set_fail_transfers`) — required for the rollback test to be a genuine proof rather than a
no-op; documented above and in `docs/contract-invariants.md`.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (127 mandate-registry + 9 mock-token tests, all pass)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```

**Unverified / left for later phases:** the full CLAUDE.md §7 invariant→test mapping remains
Phase 6's randomized property-test suite (`create → charge → pause → resume → charge → refund →
revoke` sequences asserting all 22 PLAN.md §18 invariants hold after every op). No
adversarial/malicious-token property testing of `refund` beyond the existing single-failure-
injection mock.

### Phase 6 — Invariant & Property Tests (done)

**What changed:** no contract logic changed — this phase is pure test infrastructure. Two new
test modules in `mandate-registry`: `test_property.rs` (a seeded random-action-sequence harness
with a shadow model) and `test_adversarial.rs` (a malicious-token matrix), plus one new test-only
contract crate, `contracts/evil-token` (SEP-41-shaped, with `set_fail_transfers`,
`set_lying_mode`, `set_inflated_view_mode`, and `set_reentry_target` toggles). `docs/contract-
invariants.md` gained a full Phase 6 section: the property harness design, a master table mapping
every one of PLAN.md §18's 22 invariants to the test(s) that prove it, the full adversarial-matrix
results table, and an explicit "honest boundary" note for invariant 22.

**Property harness:** hand-rolled seeded `xorshift64` PRNG (no fuzzing dependency, per the lead
decision) drives 250 sequences x 20 ops by default (~5-7s, part of `cargo test --workspace`) and
a `#[ignore]`d deep run of 3,000 sequences x 40 ops (~165s, manual invocation only) at
`test_property::property_suite_deep`. Every sequence maintains a plain-Rust shadow model that
re-implements the *exact* CLAUDE.md §6 validation order for `charge`/`refund` and the lifecycle
transition tables for `pause`/`resume`/`revoke` (including the real ordering asymmetry: `charge`
checks status/time before `merchant.require_auth()`, while the lifecycle ops check
`payer.require_auth()` first) — every op's predicted outcome is asserted against the real
contract's actual outcome, then every PLAN.md §18 invariant is re-checked against live on-chain
state. One mandate per sequence, by design (documented scope decision, see `test_property.rs`'s
module doc) — a replayed `create_mandate` is still exercised mid-sequence and proven to always
reject with `DuplicateMandate` without corrupting the existing mandate.

**Adversarial matrix — the key finding:** built `contracts/evil-token` and proved, against
`soroban-env-host-27.0.1`'s own source, that a token attempting reentrancy via the standard
`invoke_contract` path (`transfer_from` calling back into `charge`, both same- and
different-`charge_id` variants) is rejected **by the host itself**
(`ContractReentryMode::Prohibited`, "Contract re-entry is not allowed") before any contract logic
runs a second time — the rejection unwinds and aborts the *entire* outer `charge` invocation with
it, so there is no partial-mutation window to find. This is a structural host guarantee, not
something `mandate-registry` had to implement. Also proved and documented honestly: a lying token
(`transfer_from` reports success, moves nothing) leaves the mandate's *own* books
self-consistent but cannot be prevented from lying about real value movement — the fundamental,
unavoidable trust boundary with the configured asset contract (PLAN.md §18 invariant 22's honest
limit, written up explicitly in `docs/contract-invariants.md` rather than overclaimed). An
inflated pre-flight view (`balance`/`allowance` report `i128::MAX`) fools the advisory steps
13/14 checks but the *real* transfer's own failure (and the accounting-mutates-only-after
discipline) still rolls back cleanly. Plus: charge-id reuse, charge-vs-revoke ordering, and an
exact (not off-by-one either direction) period-boundary test.

**Result: zero invariant violations found** across the default gate, the deep manual run, and the
full adversarial matrix (8 tests). Nothing was loosened or worked around to make anything pass.

**Repo-hygiene deviation (flagged):** `soroban-sdk`'s default `EnvTestConfig` writes a
`test_snapshots/*.json` file on every `Env` drop in a test — appropriate (and this repo's existing
convention, already committed for every other test module) for a handful of deterministic
scenarios, disproportionate for the property harness's hundreds of throwaway randomized `Env`s per
run (250 for the default suite alone, 5.5MB observed before disabling it). Disabled snapshot
capture specifically inside `test_property.rs`'s `run_sequence` via
`env.set_config(EnvTestConfig { capture_snapshot_at_drop: false })`; every other test module
(including `test_adversarial.rs`) keeps the default and its snapshots are committed as usual.

**Commands run (all passed):**
```
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace              (148 tests: 136 mandate-registry [1 ignored: the deep
                                      property run] + 9 mock-token + 3 evil-token; ~8-11s)
cargo build --release --target wasm32v1-none
pnpm lint
pnpm typecheck
pnpm build
```
Property suite measured separately: `property_suite_default` ~5-7s (part of the run above);
`property_suite_deep` (`--ignored`, manual) ~165s for 3,000 sequences x 40 ops.

**Unverified / left for later phases:** a "soft" reentrancy variant (token catches the host's
rejection via `try_invoke_contract` and silently proceeds with the real transfer instead of
letting the panic propagate) was considered and deliberately not built — it requires a generic
error-conversion bound (`E: TryFrom<Error>, E::Error: Into<InvokeError>`) that's genuinely
uncertain to type-check without a contract-specific error type, and the "hard" variant already
answers the core question (Soroban's reentry guard is unconditional regardless of which call path
a token uses) with proportionate confidence. No true multi-thread/concurrent-submission test
exists (Soroban's local sandbox test environment is single-threaded) — "two workers submit the
same charge concurrently" is instead covered structurally (replay guards are storage-checked, not
in-memory-cached) and will get a real concurrency proof once Phase 9's relayer lands.

### Phase 7 — Deploy + Contract Client (done)

**What changed:** deployed `mandate-registry` to Stellar testnet for the first time, and built
every TypeScript package the rest of the product depends on. `scripts/deploy-testnet.ts` builds +
optimizes the wasm (`stellar contract build --package mandate-registry --optimize` — this
optimizes *in place*, overwriting `mandate_registry.wasm`; the older two-step `contract
optimize` command's separate `*.optimized.wasm` output is stale/deprecated, corrected after the
first real run failed on the wrong path), uploads it, deploys a fresh instance, and idempotently
ensures a real SEP-41 test asset exists: a classic asset `PUSD` issued by a repo-controlled
`paymap-asset-issuer` identity, wrapped in a real Stellar Asset Contract (chosen over an existing
testnet USDC SAC so the issuer key is ours and the payer can be funded to any amount with no
faucet dependency — a SAC's `approve`/`allowance`/`transfer_from`/`transfer`/`balance` semantics
are identical regardless of which classic asset it wraps). Writes the public
`deployments/testnet.json` registry (`{network, networkPassphrase, contractId, wasmHash,
deployedAt, rpcUrl, asset: {code, issuer, contractId, decimals}}`).

`packages/contract-client`: regenerated bindings via `stellar contract bindings typescript`
(byte-identical to the ones already scaffolded from a prior session, confirmed by diffing a fresh
regen against the committed file), wrapped in a hand-written domain layer (`domain.ts`) converting
every `i128`/`u64` to `bigint`, every `BytesN<32>` to a lowercase-hex string, and the generated
`{tag, values}` shapes into a proper `MandateStatus` string-literal union and `AmountRule`
discriminated union — never a JS `number` for a token quantity anywhere. `client.ts` is the typed
facade (`createMandateRegistryClient`, `getMandate`/`getPayment`/`getRefund`/`getRefundedTotal`
read convenience wrappers that throw a typed `MandateReadError`, and `buildCreateMandate`/
`buildPauseMandate`/`buildResumeMandate`/`buildRevokeMandate`/`buildCharge`/`buildRefund`
transaction builders). `deployment-registry.ts` loads `deployments/<network>.json` via a
repo-root-relative fs path (documented as a monorepo-internal convenience, since this package is
never published standalone).

`packages/stellar`: `errors.ts` — the frozen 1-24 error table with a `retryable` classification
matching CLAUDE.md §11 exactly (permanent: revoked/expired/duplicate/over-limit/too-soon/
max-count; transient, per merchant policy: insufficient allowance/balance), plus
`errors.test.ts`, which parses `contracts/mandate-registry/src/error.rs` directly with a regex
and asserts the TS table never drifts. `signer.ts`'s `keypairSigner(secretKey)` wraps a
`Keypair` as both callback shapes the generated client needs — `signTransaction` for the tx
envelope, and an `authorizeEntry` override (matching `@stellar/stellar-sdk`'s own `authorizeEntry`
signature positionally, ignoring the SDK-constructed wallet-style callback in the 2nd argument
position and delegating to the base `authorizeEntry` with a real `Keypair` instead) for one
Soroban auth entry — with zero hand-rolled hashing/signing logic. `submit.ts` implements the two
authorization flows: `submitAsInvoker` (payer signs and submits — `create_mandate`/
`pause_mandate`/`resume_mandate`/`revoke_mandate`) and `submitAsRelayer` (merchant authorizes via
`signAuthEntries`, a *separate* relayer identity submits and pays the fee — `charge`/`refund`),
both refusing to proceed past an already-simulated `Result::Err` via `assertSimulatedOk`.

`packages/shared`: `money.ts` (`decimalToBaseUnits`/`baseUnitsToDecimalString`/
`decimalToPositiveBaseUnits`, pure-`BigInt` string arithmetic, rejects over-precision and
malformed input, never rounds, never touches a JS float — 26 tests including full round-trip
identity at 0/2/7/18 decimals and an i128-range value). `types.ts` mirrors the contract's
`MandateStatus`/`AmountRule`/`Mandate`/`MandateInput`/`PaymentReceipt`/`RefundReceipt` as Zod
schemas with checksum-validated Stellar addresses (`StrKey.isValidEd25519PublicKey`/
`isValidContract`), plus compile-time `extends` assertions tying each schema's inferred type back
to `@paymap/contract-client`'s domain types (one exception: `MandateSchema` skips the compile-time
assertion for `lastChargedAt` — Zod always infers a field whose output includes `undefined` as an
optional TS property, which can never structurally match the domain type's required-but-possibly-
undefined shape under `exactOptionalPropertyTypes`; proven correct by runtime tests instead,
documented inline).

`scripts/create-demo-mandate.ts` ran the full flow for real: funded/trusted-lined the identities,
approved a bounded allowance (`5.00 PUSD x 3 charges + 1.00 buffer = 16.00 PUSD` — never
unlimited), created a mandate (payer signs and submits via `submitAsInvoker`), and charged it
(merchant authorizes via `signAuthEntries`, a genuinely separate `paymap-relayer` identity signs
the tx envelope and submits — that identity never touches the merchant's or payer's key at any
point). Real results below.

**Real testnet results:**
- Network: `testnet` (`Test SDF Network ; September 2015`), RPC `https://soroban-testnet.stellar.org`
- `mandate-registry` contract id: `CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22`
- Wasm hash: `8b4f68e3f1ecb259d7cbb7153032ac8afbd279d1c5d4eb82ee0896c935e2832c` (26,857 bytes optimized)
- Test asset: `PUSD`, issuer `GCPQA5BPDIMI6P3LRIDCKVBOAFU35VKCCWDNZN4N6QRLX4ZJUQKZTHBT`, SAC
  `CB223VUC7MMCFT352EO7QLLV6QWHXTDOXOHY2BW7DZTO3VXBXAI7DUZJ` (7 decimals)
- Payer `GCAZZ4N5H3I4VUYUJHSHVIRQYRR62IPOJ4G6L2N2WAOYHNUTOKCQWWFF`, merchant
  `GBGHMQGD7QJNGTZUCTZZUY2EO4BWF37K2K6MQCNO7IJJHCYQGTBUERV2`, relayer (separate identity, zero
  spending authority) `GC4K72YTD7VGTDHTRAW3HLPUUURYWI6GRDICLSUAOOR3L6ULC2S5TDW3`
- `approve` tx: `71b24d6385f3b9bd0f8971061c27e87a788a6ed71e2f840de83703be36ab25cd` (payer -> mandate
  contract, 160,000,000 base units = 16.00 PUSD, expiring at ledger 4,030,818)
- `create_mandate` tx: `e92c2a1c7f7c087f2d7829c7d981b6bb551219126dfcf86e1da669365390cd20`
  (mandate id `4f7eb4876c43af54876e37a7ba9f1a96bc4192820fd62cbff8e2c334400f3205`, status `Active`
  after create)
- `charge` tx: `d3c60a613fd824331ef1ae1d54478d0c6b9d5c095b3791df731260eeb9245306` (payment id
  `15a0062ec4fd4cc9797c7f0ef5a97c64ac40795b153bb1c90e63d14ceb32ca0b`, amount 50,000,000 base units
  = 5.00 PUSD, merchant-authorized/relayer-submitted)
- Mandate after charge: `status=Active successfulCharges=1/3 totalCollected=50000000
  currentPeriodCollected=50000000` — read back through `getMandate`/`getPayment`, matching the
  values `charge` returned in its own receipt exactly

**Real SAC semantics vs. `mock-token`:** matched exactly. No divergence found — `approve`,
`allowance`, and `transfer_from` behaved identically to the Phase 3-6 assumptions built and tested
against `mock-token`. No stop condition triggered.

**Merchant-authorizes/relayer-submits — the core trust assumption:** proven working end-to-end
with three genuinely distinct Stellar identities (not the same key wearing different hats). Auth
entries were assembled via `AssembledTransaction.signAuthEntries({ address: merchant.publicKey,
authorizeEntry: merchant.authorizeEntry })`, where `authorizeEntry` is a function matching
`@stellar/stellar-sdk`'s own `authorizeEntry(entry, signer, validUntilLedgerSeq,
networkPassphrase, forAddress?)` signature that ignores the SDK's internally-constructed
2nd-argument signing callback and calls the base `authorizeEntry` with the merchant's real
`Keypair` directly instead — the relayer's `Client` (constructed with the relayer as
`publicKey`/`signTransaction`) then signs and submits the outer transaction envelope. No custom
cryptography was hand-rolled anywhere in this path.

**Commands run (all passed):**
```
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test                            (14 packages; 79 new TS tests: 12 contract-client +
                                       47 shared + 8 stellar + existing 4 config, all pass)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token, unchanged
                                       from Phase 6 — no contract logic touched this phase)
tsx scripts/deploy-testnet.ts         (real testnet deploy, see results above)
tsx scripts/create-demo-mandate.ts    (real testnet create+charge, see results above)
```

**Deviations from spec (flagged, not silent):**
- `packages/contract-client/tsconfig.json` scopes off two strict-config flags *for this package
  only* (`lib` gains `"DOM"`, `noImplicitOverride: false`) — required for the generated bindings
  file to typecheck as-is; every other package keeps the base config's full strictness. Documented
  in the tsconfig itself and in `docs/architecture.md`.
- `MandateSchema`'s `lastChargedAt` field skips the compile-time schema-matches-domain-type
  assertion the other schemas have, for the Zod optional-vs-undefined reason described above.

**Unverified / left for later phases:** no load/concurrency testing of the relayer-submits flow
(single sequential demo run only) — that's Phase 9's job once a real relayer worker exists. No
`pause_mandate`/`resume_mandate`/`revoke_mandate`/`refund` exercised against the live network in
this phase's demo script (only `create_mandate` + one `charge`) — those already have full
contract-level proof from Phase 2-6's test suites and don't change based on which token they run
against, so re-proving them against testnet specifically was judged lower-value than the
asset/auth-flow proof this phase actually needed; a natural target for Phase 9's relayer
integration tests once that worker exists. `apps/api`/`apps/relayer` do not yet read
`deployments/testnet.json` or `MANDATE_CONTRACT_ID` from a live environment (Phase 8+).
