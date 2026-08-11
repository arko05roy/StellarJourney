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

- [x] Prisma schema: User, Merchant, Product, CheckoutSession, MandateIndex, ChargeRequest, Payment, WebhookDelivery, IdempotencyKey (PLAN.md §13) — plus `ApiKey` and `RefundRequest`, both necessary additions (see Review below)
- [x] Unique constraints: `(merchantId, idempotencyKey)`, `chargeId`, `paymentId`, `refundId`, webhook `eventId`
- [x] API key issue/hash/rotate; shown once; `API_KEY_HASH_SECRET`
- [x] Endpoints (PLAN.md §14) — every input Zod-validated
- [x] Idempotency middleware: store merchant+key+request hash+status+body; different hash w/ same key → 409
- [x] ChargeRequest state machine w/ DB transactions (CLAUDE.md §17)
- [x] Contract-error → API-error mapping, original code preserved, no generic `INTERNAL_ERROR`
- [x] Rate limits on key-issuance + charge endpoints
- [x] Tests: auth, validation, idempotency replay + conflict, state transitions

**Gate:** `pnpm test` (API integration suite w/ Docker Postgres).

**Rule:** API never writes `Payment` from its own state — only from confirmed on-chain result.

---

## Phase 9 — Relayer

- [x] BullMQ worker; deterministic job id = `chargeRequest.id`
- [x] Pipeline: load fresh on-chain mandate → build invocation → simulate → verify merchant/amount/asset/charge_id match request → submit → poll final status → persist tx hash + ledger
- [x] Failure classifier: permanent (revoked, expired, duplicate, over-limit, too soon, max count) vs transient (RPC, timeout, not-included, balance/allowance per merchant policy)
- [x] Retry schedule: +6h, +24h, +72h → `permanently_failed`
- [x] Concurrency test: two workers, same job → at most one success
- [x] Event reconciliation: confirmed final on-chain `Result` (equivalent trust level to `charge_succeeded`, see Review) → `Payment` row
- [x] Tests: classification table, duplicate job, stale-simulation handling

**Gate:** `pnpm test` + one scheduled payment executes end-to-end on testnet — both done, see Review.

**Invariant:** relayer key has zero spending authority. Assert in test that relayer-signed charge with altered amount fails.

---

## Phase 10 — Consumer Checkout

- [x] Next.js App Router, Tailwind, shadcn/ui
- [x] Stellar Wallets Kit connect
- [x] Checkout page: merchant identity, product, **all terms visible, none collapsed** (CLAUDE.md §13)
- [x] Max-exposure calculator: `min(max_per_charge × max_charges, max_per_period × periods_until_expiry)` — show number
- [x] Two-step sign: `create_mandate` → bounded `approve` (remaining theoretical max + explicit fee headroom). Never unlimited.
- [x] Allowance-change flow: zero → confirm → set new
- [x] Confirmation screen: mandate id, next eligible charge date

**Gate:** `pnpm test` + Playwright happy path — both ran, all green (see Review below).

---

## Phase 11 — Consumer Dashboard

- [x] Nav: Upcoming / Active / History / Paused & Ended / Settings
- [x] Mandate card: merchant, asset, amount or max, frequency, next eligible date, period usage, expiry, status
- [x] Pause / Resume / **Cancel autopay** (revoke) + allowance-to-zero prompt
- [x] Payment history + failed attempts with human-readable reason
- [x] Read from contract state, not DB, for status display

**Gate:** `pnpm test`, `pnpm test:e2e`. New user completes full flow with zero CLI.

---

## Phase 12 — Merchant Dashboard + Webhooks + SDK

- [x] Dashboard: products, checkout links, mandates, upcoming, failed, payments, refunds, developers, webhooks (Phase 12b — done, see Review)
- [x] Webhook delivery worker: HMAC SHA-256, timestamp, event id, signature version, retry count header
- [x] Delivery state machine: pending → delivering → delivered | retry_scheduled → dead_letter
- [x] Stable event id across retries
- [x] All 8 events wired where a producer can exist without an on-chain indexer (`payment.succeeded`, `payment.failed`, `mandate.completed`); the other 5 (`mandate.active/paused/resumed/revoked`, `refund.succeeded`) have no producer yet — documented, not stubbed (`docs/merchant-api.md`'s "which events actually have a producer today")
- [x] `packages/sdk`: `checkoutSessions.create`, `charges.create`, `payments.refunds.create`, typed error codes, `verifyWebhook` helper
- [x] Every SDK method gets a working example in `docs/merchant-api.md`
- [x] Tests: signature verify, retry backoff, duplicate event handling, secret never in payload

**Gate:** `pnpm test`; sample merchant app receives `payment.succeeded` — real local `node:http`
receiver, real `sendWebhook`, real signature verification
(`apps/relayer/src/webhook-delivery.test.ts`'s last `describe` block). Ran green.

---

## Phase 13 — End-to-End Test

Single Playwright test covering the CLAUDE.md §14 chain:

```
merchant product → checkout session → wallet auth → mandate creation
→ token approval → charge request → relayer execution → webhook
→ consumer payment history → revocation → later charge rejected
```

**Gate:** [x] `pnpm test:e2e:system` green against testnet.

---

## Phase 14 — Security Hardening

- [x] Write `docs/threat-model.md` — all 9 threats (PLAN.md §19) → mitigation → proving test
- [x] Adversarial suite (PLAN.md §20.5): relayer alters amount, merchant alters asset, charge-id reuse, concurrent workers, charge-vs-revoke race, period-boundary race, stale simulation
- [x] Secret audit: no keys in source, no secrets logged, testnet/local key separation
- [x] Structured logs with `mandateId/chargeId/merchantId/txHash/requestId`; redaction test
- [x] Observability counters (PLAN.md §21)
- [x] Rate limits verified under load

**Gate:** zero open critical/high in internal checklist. Full command set from CLAUDE.md §15.

---

## Phase 15 — Demo Polish

- [x] `scripts/seed-demo.ts` — merchant, consumer, fixed plan, variable plan
- [x] Transaction timeline UI
- [x] Scripted demo scenes (PLAN.md §23): success → over-limit rejection → revocation → post-revoke rejection
- [x] `docs/demo-script.md` + architecture diagram
- [x] `README.md` one documented command sequence from clean env

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

### Active: Phases 13–15

#### Plan

- [x] Audit Phase 13 E2E chain and implement missing Playwright coverage.
- [x] Complete Phase 14 threat model, adversarial tests, secret/log audits, counters, and load checks.
- [x] Complete Phase 15 seed/demo timeline/scenes/docs/README.
- [x] Validate wallet connect, deployment evidence, Stellar SDK integration, and frontend/contract function matching.

#### Verification

- [x] Run full TypeScript lint, typecheck, build, unit, and E2E gates.
- [x] Run Rust fmt, clippy, tests, and optimized contract build.
- [x] Inspect final diff and map every requirement to direct evidence.

#### Files likely touched

- `apps/web/e2e/`
- `apps/web/src/`
- `apps/api/src/`
- `apps/relayer/src/`
- `scripts/`
- `docs/`
- `README.md`
- `tasks/todo.md`

#### Questions

- None.

### Changed

- Phase 13 real-testnet system E2E; SDK live error/Option decoding fixes.
- Phase 14 threat model, adversarial/load tests, redacted logs, metrics, secret audit.
- Phase 15 seed/bootstrap, transaction timeline, demo scenes, architecture/demo docs, README.

### Verified

- TS install/lint/typecheck/build/unit; Playwright stub 8/8 and system 1/1.
- Rust fmt/clippy; 148 tests; optimized Wasm hash matches deployment.
- Live demo seed idempotent; all four protection scenes pass.
- Live deployed ABI: all 11 functions match generated client.

### Risks

- Production merchant authorization transport remains intentionally fail-closed.
- Metrics are process-memory only; API keys are merchant-wide.

### Follow-ups

- Add external metrics sink and non-custodial merchant authorization transport before production.

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
the auth mocked for the _wrong_ address (merchant, a random third party standing in for "the
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
period_seconds` (new `math::checked_mul_u64` helper), then derives the _effective_
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
an explicit assertion that `current_period_start` is the computed boundary and _not_ `now`; the
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
`max_successful_charges`, the mandate completes _in the same charge that reached the cap_, so any
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
`RefundNotFound = 24` — genuinely needed since `DuplicateRefund` (19) means the _opposite_ thing
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
`refund_id` rejected both with a different amount against the _same_ payment and against a
_completely different_ payment under the same mandate (proving the global, not per-payment,
uniqueness scope); zero/negative amount rejected; unknown `payment_id` and unknown `mandate_id`
rejected; a payment that belongs to a _different_ mandate rejected with `PaymentNotFound`;
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
re-implements the _exact_ CLAUDE.md §6 validation order for `charge`/`refund` and the lifecycle
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
runs a second time — the rejection unwinds and aborts the _entire_ outer `charge` invocation with
it, so there is no partial-mutation window to find. This is a structural host guarantee, not
something `mandate-registry` had to implement. Also proved and documented honestly: a lying token
(`transfer_from` reports success, moves nothing) leaves the mandate's _own_ books
self-consistent but cannot be prevented from lying about real value movement — the fundamental,
unavoidable trust boundary with the configured asset contract (PLAN.md §18 invariant 22's honest
limit, written up explicitly in `docs/contract-invariants.md` rather than overclaimed). An
inflated pre-flight view (`balance`/`allowance` report `i128::MAX`) fools the advisory steps
13/14 checks but the _real_ transfer's own failure (and the accounting-mutates-only-after
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
optimizes _in place_, overwriting `mandate_registry.wasm`; the older two-step `contract
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
`signAuthEntries`, a _separate_ relayer identity submits and pays the fee — `charge`/`refund`),
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

- `packages/contract-client/tsconfig.json` scopes off two strict-config flags _for this package
  only_ (`lib` gains `"DOM"`, `noImplicitOverride: false`) — required for the generated bindings
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

### Phase 8 — Merchant API (done)

**What changed:** built `apps/api` — a Fastify 5 server exposing PLAN.md §14's ten endpoints plus
two necessary additions (`POST /v1/merchants`, `POST /v1/merchants/me/api-keys/rotate` — CLAUDE.md
§10 requires key issue/hash/rotate; there's no way to obtain the first key without some endpoint).
`prisma/schema.prisma` gained 9 named models (`User`, `Merchant`, `Product`, `CheckoutSession`,
`MandateIndex`, `ChargeRequest`, `Payment`, `WebhookDelivery`, `IdempotencyKey`) plus two flagged
additions: `ApiKey` (a one-to-many table under `Merchant` — PLAN.md §13 puts `apiKeyHash` directly
on `Merchant`, which can't express rotation-with-history) and `RefundRequest` (needed to give
`refundId` its own unique constraint distinct from `paymentId`, since `Payment` has no refund
fields at all). Every money column is a `String` holding integer base units (never `Decimal`/
`Int`/`Float`); every enum (`ChargeRequestStatus`, `WebhookDeliveryStatus`, etc.) is explicit.
`ChargeRequestStatus` is reused verbatim for `RefundRequest.status` — no separate refund-request
lifecycle exists in the spec and the states are identical in shape.

**Generated Prisma client placement (deviation, verified necessary):** `generator client` in
`prisma/schema.prisma` sets an explicit `output = "./generated/client"` rather than the classic
`node_modules/@prisma/client` default. Verified necessary, not stylistic: with no `output`,
`prisma generate` resolves `@prisma/client` relative to the _schema's_ directory (repo root
`prisma/`), and when unsatisfied there it shells out to `pnpm add @prisma/client@<version>` —
which reliably failed every time with exit code 1 when that subprocess was itself spawned from
inside another `pnpm run` invocation (this workspace's lockfile/store contention; running the
identical `pnpm add` command directly, not nested, always succeeded). The explicit `output` path
sidesteps the whole class of problem and is also Prisma's own documented forward-compatible
pattern for pnpm monorepos. `apps/api/src/db.ts` is the single file that knows the relative
repo-root-reaching path (mirrors `packages/contract-client/src/deployment-registry.ts`'s existing
convention); every other module imports Prisma types from `db.ts`, never the generated output
directly. `prisma/generated/` is gitignored; `apps/api/package.json`'s `typecheck`/`build`/`test`
scripts all regenerate it first (`prisma generate`/`migrate deploy` are idempotent, ~70ms).

**API key hashing:** `apps/api/src/auth/api-key.ts` — HMAC-SHA256 with `API_KEY_HASH_SECRET` as
pepper (never a bare hash of the key). Raw key format `sk_live_<32 random bytes, base64url>`. A
short, non-secret `keyPrefix` (first 19 chars) is an indexed lookup aid only; the actual match is
`crypto.timingSafeEqual` on the full digest — genuinely constant-time, not just an indexed
equality check. Distinguishes `INVALID_API_KEY` (no match) from `API_KEY_REVOKED` (hash matches a
since-rotated-out key) from `MERCHANT_DISABLED` (valid key, disabled account) — three different
401/403 codes, not one generic auth failure. Rotation (`rotateApiKey`) revokes the old row and
inserts the new one inside one `$transaction` — never a window with zero or two active keys.

**Idempotency concurrency-safety — a real bug found and fixed, not assumed correct:** the first
implementation caught Prisma's `P2002` (unique-violation) from a plain `.create()` inside the
transaction and then tried to `SELECT` the winning row in the _same_ transaction — this reliably
failed with Postgres error `25P02` ("current transaction is aborted") under the concurrency test,
because a real constraint-violation error poisons the _entire_ enclosing transaction, not just the
one statement; every subsequent query in that transaction fails too. Fixed by replacing the insert
with raw SQL: `INSERT ... ON CONFLICT ("merchantId", "key") DO NOTHING RETURNING id` — Postgres
still applies the identical MVCC blocking rule (a concurrent transaction's insert of the same key
blocks until the first commits or rolls back), but `ON CONFLICT DO NOTHING` never raises a
Postgres-level error on the real conflict, only returns zero rows, so the enclosing transaction
stays healthy and can immediately `SELECT` the winner's now-committed, fully-populated response.
Verified with a real test: 8 concurrent `runIdempotent` calls with the same key/body against a
real Postgres produce exactly 1 execution and 8 identical responses (`idempotency/middleware.test.ts`).
The insert, the handler, and the response-write all share one transaction — a handler that throws
rolls the idempotency record back too, so a failed attempt never "burns" the key.

**On-chain precheck:** `apps/api/src/chain/precheck.ts` mirrors
`contracts/mandate-registry/src/charge.rs`'s validation order for every step answerable from the
`Mandate` struct alone (status, start/expiry, amount rule, min interval, max count, period
rollover+cap) — deliberately skips merchant-auth/duplicate-charge-id (meaningless before a
signature/charge-id exist) and allowance/balance (duplicates the relayer's own Phase 9 pre-flight;
a charge that clears this precheck can still fail those two at actual submission). Routes depend
on a narrow `MandateReader` interface (`apps/api/src/chain/mandate-reader.ts`), never
`@paymap/contract-client` directly — tests inject a fake, in-memory reader with canned mandate
states instead of hitting real Soroban RPC; the production wrapper
(`createChainMandateReader`) is a thin pass-through to `@paymap/contract-client`'s real
simulation-backed reads. The precheck runs _before_ the idempotency transaction (a pure read, so a
retry re-validating fresh state is strictly more correct than replaying a stale verdict).

**ChargeRequest state machine:** `apps/api/src/state-machine.ts` — a pure guard table
(`assertLegalChargeRequestTransition`) plus a DB-atomic `transitionChargeRequest` (a guarded
`updateMany` scoped to the expected current status, so two concurrent transition attempts can
never both apply). Exactly the edges CLAUDE.md §17 draws; Phase 8 only ever writes `scheduled`.

**Rate-limit bug found while testing, fixed:** `@fastify/rate-limit` (verified against its own
source, `index.js:333`) does `throw params.errorResponseBuilder(req, respCtx)` **verbatim** — the
custom builder's return value becomes the "error" Fastify's central error handler receives,
_not_ wrapped in an `Error` with `.statusCode` set automatically (only its own _default_ builder
does that). An initial custom builder returning `{code, message}` with no `statusCode` field was
silently swallowed into the generic 500 branch instead of ever producing a 429. Fixed by including
`statusCode: context.statusCode` in the builder's return value (mirroring what the plugin's own
default does) and checking for that shape (not `instanceof Error`) in the app's error handler.
Caught by the rate-limit test itself, not discovered by inspection.

**Tests:** 142 tests across 12 files in `apps/api`, all real integration tests against the
Postgres started by `docker-compose.yml` (no mocked database anywhere) — `auth/api-key.test.ts`
(10: hashing determinism/pepper-sensitivity, valid/invalid/malformed/wrong-secret/revoked/
disabled-merchant auth, rotation), `state-machine.test.ts` (54: every one of the 7×7 transition
pairs asserted legal or illegal, plus DB-atomicity), `chain/precheck.test.ts` (21: every contract
error code the precheck can produce, plus exact period-boundary/min-interval-boundary tests),
`idempotency/middleware.test.ts` (6: replay, conflict, per-merchant isolation, 8-way concurrency),
`errors.test.ts` (2: every one of the 24 frozen contract codes maps to a non-`INTERNAL_ERROR`
status), and 7 route-level files (`merchants`, `products`, `checkout-sessions`, `mandates`,
`charges`, `payments`, `webhook-endpoints`) covering auth requirements, every Zod-rejection class
(bad address, unknown asset, zero/negative/over-precision amount, unbounded duration, non-http(s)
webhook URL), idempotency replay/conflict/concurrency at the route level, mandate-ownership
404-not-403, and rate-limiting. Run via `docker compose up -d && pnpm --filter @paymap/api test`
(or `pnpm test` from the root); documented in `docs/merchant-api.md`.

**CI:** `.github/workflows/ci.yml`'s `node` job gained a `postgres:16` service container +
job-level `DATABASE_URL` so `pnpm test` (now including `apps/api`'s real-Postgres suite) runs
unchanged in CI.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (14/14 tasks)
pnpm typecheck                       (14/14 tasks)
pnpm build                           (14/14 tasks)
pnpm test                            (14/14 tasks; apps/api: 142 new tests, all pass)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token + 3
                                       evil-token, unchanged — no contract touched this phase)
```

**Deviations from spec (flagged, not silent):**

- Two endpoints beyond PLAN.md §14's literal list (`POST /v1/merchants`,
  `POST /v1/merchants/me/api-keys/rotate`) — necessary for CLAUDE.md §10's key issue/rotate
  requirement to be reachable at all. Documented in `docs/merchant-api.md`'s scope-note section.
- `ApiKey` and `RefundRequest` models beyond PLAN.md §13's literal 9-model list — both load-bearing
  for explicit CLAUDE.md §5 requirements (rotation-with-history; a `refundId` unique constraint
  distinct from `paymentId`), documented in `prisma/schema.prisma`'s header comment.
- Rate limiting is IP-keyed for every route, including authenticated ones (not merchant-scoped) —
  simplest correct MVP choice; documented as a deferred refinement in both
  `docs/merchant-api.md` and the new Phase 8 section of `docs/threat-model.md`.
- The on-chain charge precheck does not check token allowance/balance (steps 13-14 of
  `charge.rs`) — deliberately deferred to the relayer's own Phase 9 pre-flight rather than
  duplicating a token-client dependency here; documented in `precheck.ts`'s module doc.
- `POST /v1/webhook-endpoints/test` never makes a live outbound HTTP call (queues a `pending`
  `WebhookDelivery` row only) — explicit Phase 8 scope boundary ("don't build the worker"); real
  delivery needs Phase 14's SSRF hardening first, noted in `docs/threat-model.md`.

**Unverified / left for later phases:** no relayer exists yet, so `ChargeRequest`/`RefundRequest`
rows never progress past `scheduled` in this phase (Phase 9). Refund submission (merchant-
authorizes/relayer-submits, mirroring `charge`) is not implemented — Phase 8 only validates and
schedules a `RefundRequest`; which future phase drives it to submission was not specified by the
lead and is flagged here rather than guessed at. Webhook HMAC signing and the delivery worker are
Phase 12. Turborepo's file-hash-based task caching for `apps/api` does not explicitly declare
`../../prisma/schema.prisma`/`../../prisma/migrations/**` as tracked `inputs` — a schema-only edit
with zero changes inside `apps/api` itself could theoretically hit a stale cache; low-risk (the
generated client is regenerated unconditionally at the start of every script invocation that does
run) and not fixed in this phase to avoid touching the shared root `turbo.json` for a single
package's edge case.

### Phase 9 — Relayer (done)

**What changed:** built `apps/relayer` — a BullMQ worker + scheduler that executes `ChargeRequest`s
against real Soroban state, with zero policy or spending authority (CLAUDE.md §11). New files:
`src/pipeline.ts` (`processChargeRequest` — the full 10-step pipeline), `src/chain-gateway.ts`
(`ChainGateway` interface + `createSorobanChainGateway`, the seam to real RPC), `src/classify.ts`
(failure classification table), `src/retry-schedule.ts` (+6h/+24h/+72h schedule), `src/queue.ts` /
`src/worker.ts` / `src/scheduler.ts` (BullMQ wiring), `src/context.ts` (resolves expected
merchant/asset for verification), `src/webhook.ts` (enqueues `pending` `WebhookDelivery` rows —
delivery itself is Phase 12), `src/config.ts` / `src/db.ts` / `src/index.ts` (production
entrypoint, replacing the Phase 0 placeholder). `prisma/schema.prisma` gained
`ChargeRequest.nextAttemptAt` (`DateTime?`, indexed) — the field the scheduler needs to find due
retries; migration `20260727181410_phase9_relayer_next_attempt`.

**Reused, not duplicated:** `apps/api/src/state-machine.ts`'s `transitionChargeRequest`/
`assertLegalChargeRequestTransition`, imported from `apps/relayer` via
`@paymap/api/dist/state-machine.js` (a new workspace dependency, `apps/relayer` on `@paymap/api`
— the first cross-app dependency in this repo; turbo's `dependsOn: ["^build"]` already orders
`@paymap/api#build` before `@paymap/relayer#build`, so this needed no `turbo.json` change). Per
Phase 8's own review note ("Phase 9 owns whatever retry-scheduling transition eventually re-enters
processing"), added exactly the one edge Phase 8 deliberately left unowned:
`retryable_failed -> processing`. Updated `state-machine.test.ts`'s "terminal states" assertion
(it previously asserted `retryable_failed` had zero legal outgoing edges) to match — the generic
transition-table-driven test loop needed no changes, only the one hand-written assertion.

**The `ChainGateway` seam:** `pipeline.ts` depends on a narrow `ChainGateway` interface, never on
`@paymap/contract-client`/`@paymap/stellar` directly — mirrors `apps/api/src/chain/mandate-reader.ts`'s
established "fake in tests, thin real wrapper in production" pattern. Every Postgres/Redis
integration test runs against a deterministic in-memory `FakeChainGateway`
(`apps/relayer/src/test/helpers.ts`) — no live Soroban RPC in the default `pnpm test` run, but the
production `createSorobanChainGateway` is proven once against real testnet (below) using the exact
same pipeline code.

**A genuine SDK finding, not assumed:** `@stellar/stellar-sdk`'s `AssembledTransaction.signAndSend()`
already polls `getTransaction` to a final status internally (`SentTransaction.send()`, up to
`DEFAULT_TIMEOUT` = 5 minutes, verified by reading the SDK's own source at
`node_modules/.pnpm/@stellar+stellar-sdk@16.1.0/.../sent_transaction.js`) — CLAUDE.md §11's "poll
for final transaction status" step (7) did not need a hand-rolled polling loop; `submitAsRelayer`
(already built in Phase 7) already returns a `SentTransaction` whose `.result` is the _confirmed_
on-chain outcome, parsed from `getTransactionResponse.returnValue`, not the earlier simulation.
This is also what "event reconciliation" (step 8) uses: the `Payment` row is written from this
confirmed final `Result`, which carries the same trust level as parsing the `charge_succeeded`
event's data payload (both derive from the same finalized ledger entry) — a separate
event-subscription/log-scanning subsystem was judged out of this phase's bounded scope and not
built; flagged here rather than silently substituted.

**A real bug found via real concurrent execution, not by inspection:** `apps/api` and
`apps/relayer` share one Postgres database (`docker-compose.yml`'s single `paymap` DB — one
backend data model, CLAUDE.md §4, not a duplicate). Turbo's task graph has no ordering between
`@paymap/api#test` and `@paymap/relayer#test` (only `dependsOn: ["^build"]`), so `pnpm test` from
the repo root runs both real-Postgres suites _concurrently_ — and both call a full
`cleanDatabase()` at nearly every test's `beforeEach`. This produced real, observed FK-violation
failures (one suite's cleanup deleting rows the other suite's in-flight test still needed) the
first time the full gate ran with both suites present — not a hypothetical race. Fixed by giving
`apps/relayer`'s tests a distinct Postgres _schema_ (`relayer_test`, a namespace within the same
database — `apps/relayer/package.json`'s `test` script exports `DATABASE_URL` with
`schema=relayer_test` before `prisma migrate deploy`/vitest; `vitest.setup.ts` defaults to the same
for a bare `vitest` invocation). Full physical isolation, zero process-level coordination needed;
documented in `vitest.setup.ts`'s comment so a future phase doesn't reintroduce the collision.

**Classification table** (`apps/relayer/src/classify.ts` — consumes `packages/stellar`'s own
`retryable` flag per contract error, never re-derives it; throws `UnclassifiableContractError`,
never defaults to a retry, for any name outside the frozen 24):

| permanent (14)           | permanent (10, cont.)  | transient (2)         |
| ------------------------ | ---------------------- | --------------------- |
| MandateNotFound          | PaymentNotFound        | InsufficientAllowance |
| MandateNotActive         | RefundExceedsPayment   | InsufficientBalance   |
| MandatePaused            | DuplicateRefund        |                       |
| MandateRevoked           | ArithmeticOverflow     |                       |
| MandateCompleted         | InvalidMandateInput    |                       |
| MandateExpired           | DuplicateMandate       |                       |
| ChargeBeforeStart        | InvalidStateTransition |                       |
| ChargeTooSoon            | RefundNotFound         |                       |
| InvalidAmount            |                        |                       |
| AmountExceedsChargeLimit |                        |                       |
| AmountExceedsPeriodLimit |                        |                       |
| ChargeCountExceeded      |                        |                       |
| DuplicateCharge          |                        |                       |
| UnauthorizedMerchant     |                        |                       |

Plus three infra-observed conditions, always transient and never contract-error codes at all:
`RPC_UNAVAILABLE`, `SEND_FAILED`, `TX_NOT_INCLUDED`.

**Duplicate-delivery proof (the headline test) — real output:**

```
✓ src/pipeline.test.ts > processChargeRequest > duplicate job delivery — at most one successful
  charge > two concurrent processChargeRequest calls for the SAME ChargeRequest produce exactly
  one succeeded outcome, one Payment row, and one on-chain submit() call
```

Two independent `PrismaClient` connections (simulating two separate worker processes) race
`processChargeRequest` on the same `ChargeRequest` id via `Promise.all` against a real Postgres,
sharing only the chain gateway (to count real "chain" calls). Asserted: exactly one `succeeded`
outcome and one `skipped_not_claimable`, exactly one `gateway.submit()` call, exactly one `Payment`
row. The guarantee is the DB-guarded `scheduled|retryable_failed -> processing` transition — not
BullMQ's own job locking, which this system deliberately does not rely on alone.

**"Relayer cannot alter amount or destination" — how it was proven, two layers:**

1. _Structural (on-chain, inherited from Phase 3/4/6):_ `buildCharge` takes no merchant/destination
   argument at all — the contract reads the payout address only from stored `Mandate` state; `amount`
   is bound inside the merchant's Soroban authorization entry (hash includes function+args), so
   altering it after signing invalidates the signature. This was already proven by the Phase 3/4/6
   Rust test suites; Phase 9 depends on it rather than re-proving it.
2. _Application-level, defense-in-depth, newly tested this phase:_ `apps/relayer/src/pipeline.test.ts`'s
   "relayer cannot alter amount or destination" suite — a simulated receipt with a different
   merchant, an inflated amount, or a different asset than the `ChargeRequest`/`Product` describe is
   rejected (`SIMULATION_MISMATCH`, permanently failed) with `gateway.submitCallLog` asserted empty
   in every case — i.e. the point that would carry a signature to the network is never reached.

**Real testnet run — actually executed, tx hash recorded:** `scripts/run-relayer-testnet-demo.ts`
ran the real `createSorobanChainGateway` + `processChargeRequest` (the exact pipeline code the
BullMQ worker runs, not a parallel one-off) against Stellar testnet:

- mandate id: `17943c35498152a43ce01c3119dbfb340a0069877590af2a357d68223dbfff76`
- `create_mandate` tx (payer signs/submits directly, Phase 7-style):
  `8e03653aeddaae57aa8f24176f2f5d51c395356fb97b1c8d75e3166ffbefd5d8`
- relayer-executed `charge` tx (via `processChargeRequest`):
  `86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c`, ledger `3835099`
- payment id: `8a17da06153d3cd7ac34e18b713aa431295fc43759c6ca52924b99cc5e794b85`
- pipeline outcome: `{"kind":"succeeded","paymentId":"8a17da06...","txHash":"86b09bb3..."}`
- one `Payment` row written, `ChargeRequest` transitioned to `succeeded` — via the real DB
  transaction path, not a mock

**Deviation (flagged, not silently resolved) — merchant charge-authorization is an open question:**
`charge()` requires `mandate.merchant.require_auth()` on every call. No mechanism was defined in
Phases 1-8 for a merchant's signature to reach the relayer without it custodying a merchant secret
key. `ChainGateway`'s `resolveMerchantSigner` is an injected seam so this isn't silently papered
over: the production entrypoint (`apps/relayer/src/index.ts`) throws a clear, actionable error
rather than pretending to work; the required testnet proof script supplies the same known demo
merchant keypair Phase 7 already used (acceptable for a demo, not a production design). Full
writeup: `docs/threat-model.md`'s "Open trust-model question: merchant charge authorization" entry.
This did not block the phase's actual deliverable (the pipeline itself, fully built and tested) —
it blocks only a _future_ phase's move to real multi-merchant production wiring.

**Other deviations (flagged):**

- Two additive schema changes beyond the literal brief: `ChargeRequest.nextAttemptAt` (necessary —
  the scheduler cannot find due retries without it) and the `retryable_failed -> processing` edge
  (explicitly anticipated by Phase 8's own review).
- `apps/relayer` depends on `@paymap/api` (workspace) for the shared state machine — the first
  cross-app dependency in this repo. A `packages/` extraction would be more conventional long-term,
  but the brief explicitly said "reuse them, do not write a second copy," and Phase 8 already built
  the canonical table inside `apps/api`; moving it now would be a larger, non-requested refactor.
  Flagged for a future cleanup pass, not silently accepted as ideal.
- `Payment.ledger`/ `transactionHash` are populated from the SDK's confirmed `getTransactionResponse`,
  not from a separate contract-event subscription — see the SDK finding above.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (16/16 tasks)
pnpm test                            (16/16 tasks; apps/api: 143 tests; apps/relayer: 56 new tests,
                                       all pass)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token + 3
                                       evil-token, unchanged — no contract touched this phase)
pnpm --filter @paymap/scripts run demo:relayer   (real testnet run, see tx hashes above)
```

**Unverified / left for later phases:** no real BullMQ `Worker` process was run end-to-end against
live jobs in this phase's tests (`worker.ts` is thin wiring around the already-tested
`processChargeRequest`, exercised structurally but not via an actual running `Worker` consuming a
real job in the test suite — `queue.ts`/`scheduler.ts` _are_ tested against real Redis). A process
crash mid-poll (between the `submitted` DB write and `submit()`'s up-to-5-minute result) would
leave a `ChargeRequest` stuck at `submitted` with no automatic recovery — no reconciliation sweep
for stuck-`submitted` rows exists yet, flagged as a real gap for a future phase. Webhook _delivery_
remains Phase 12 (this phase only enqueues `pending` rows, per CLAUDE.md's own step 10 scoping).
Refund submission (mirroring `charge`) still does not exist — `RefundRequest` rows still never
progress past `scheduled`, unchanged from the Phase 8 review's own note.

### Phase 10 — Consumer Checkout (done)

**What changed:** built `apps/web`'s consumer checkout page (`/checkout/[sessionId]`) end to end.
Invoked the `shadcn` skill (installed via `npx shadcn@latest init`/`add`, `base-nova` preset,
neutral base color, `lucide` icons — Button/Card/Badge/Separator/Alert/Dialog/Skeleton/Input/Label)
and `design-taste-frontend` (noted it is scoped to landing pages/portfolios and explicitly excludes
"multi-step product UI" — this checkout flow is exactly that, so only the universal parts applied:
no crypto-glow/gradients, one accent color, dark mode via `prefers-color-scheme`, WCAG AA, real
icon library instead of hand-rolled SVGs).

**New files, `apps/web/src`:** `lib/mandate-terms.ts` (pure — `deriveMandateTerms`,
`computeMaxExposure`, `computeBoundedAllowance`), `lib/checkout-state.ts` (the flow's reducer,
independently tested), `lib/{api,env,errors,format,ids,wallet,chain-gateway,test-stubs}.ts`,
`components/checkout/*` (`terms-list`, `max-exposure-callout`, `wallet-connect-button`,
`error-banner`, `confirmation-card`, `checkout-flow`, `checkout-page-client`),
`app/checkout/[sessionId]/{page,loading,not-found,error}.tsx`.

**Max-exposure formula (as implemented, `lib/mandate-terms.ts::computeMaxExposure`):**
`maxSuccessfulCharges === 0` (unlimited count, contract's own convention) → period bound only
(`maxPerPeriod × ceil((expiresAt - startAt) / periodSeconds)`); otherwise
`min(perCharge × maxSuccessfulCharges, maxPerPeriod × periodsUntilExpiry)`. All-`bigint`, no
`Number` anywhere in the calculation (proven directly by a `10n**30n`-amount test case).

**Bounded allowance:** `computeBoundedAllowance(maxExposure)` = `maxExposure` + a disclosed 1%
(`ALLOWANCE_FEE_HEADROOM_BPS = 100n`, rounded up) headroom, shown to the payer as its own line
before signing. **Flagged, not fully resolved:** the brief's "small explicit fee headroom" wording
is ambiguous about _why_ a same-asset buffer is needed on top of an already-exact theoretical
maximum (network fees are paid in XLM, not the approved asset) — implemented as a conservative,
transparent, non-zero constant per the literal instruction, but the product rationale needs lead
confirmation; 1% was my own judgment call, not derived from a spec number.

**Two-step signing + failure modes:** `create_mandate` (payer-signs-and-submits, `submitAsInvoker`)
then a bounded `approve` on the product's asset contract (new `packages/stellar/src/token.ts` —
the mandate-registry generated client only knows that one ABI; a SAC has no published Wasm to
derive a spec from, so this drives `AssembledTransaction.build` directly). Failure modes, all
handled explicitly (`lib/checkout-state.ts`'s reducer + `checkout-flow.tsx`):

- Wallet rejection / insufficient balance / network error → classified by `lib/errors.ts::toDisplayError`
  into specific consumer-language messages (never generic), contract errors go through
  `@paymap/stellar`'s frozen table so the code is never lost.
- **Step 1 succeeds, step 2 fails** — the explicit scenario called out in the brief.
  `CREATE_MANDATE_SUCCESS` sets `mandateId` on state and no later `APPROVE_ERROR` clears it; the UI
  renders "created but not funded yet" with a **Complete the approval** button that retries `runApprove`
  directly, reading `mandateId`/`address` off state — never a dead end. Proven by
  `checkout-state.test.ts`'s dedicated test.
- **Link-to-session failure after a successful approve** (mandate exists and is funded on-chain,
  only the merchant-dashboard association failed) — deliberately a non-blocking warning on the
  confirmation screen (`state.linkWarning`, with its own retry), not a hard "error" phase, since
  nothing fund-related actually failed (CLAUDE.md §2).

**Allowance-change flow (zero → confirm → set new, PLAN.md §10.10):** implemented in
`checkout-flow.tsx::runApprove` — the mandate contract is one shared spender across every mandate
a payer has ever created, so a returning payer may already have a non-zero allowance from an
earlier mandate; setting a new absolute amount directly on top of an unknown existing value is
exactly the ambiguity this sequence exists to avoid. Queries current allowance first
(`ChainGateway.queryAllowance`, new); if non-zero, submits `approve(amount=0)`, re-queries to
confirm it landed as `0`, only then submits the real bounded amount — skipped entirely (no extra
signature requested) when there is nothing to reset, the common first-mandate case. Proven by
`checkout-flow.test.tsx`'s two tests (asserts the exact `approve` call sequence/amounts in both
branches).

**Stop-condition check — none triggered:** Stellar Wallets Kit (`@creit.tech/stellar-wallets-kit`
v2.5.0, static-class API — verified against the installed package's actual `.d.ts`, not assumed
from training data) produces `signTransaction`/`signAuthEntry` callbacks that match
`@stellar/stellar-sdk/contract`'s `SignTransaction`/`SignAuthEntry` shapes exactly, no adapter
needed. No unlimited allowance was ever required. Every required term fit on one screen with
nothing collapsed (proven by `terms-list.test.tsx`'s explicit "no `<details>`/`aria-expanded`/
`hidden` anywhere" assertion).

**Backend additions this phase required (apps/api), not originally in Phase 10's file list:**

1. Two new **unauthenticated** routes on `checkout-sessions.ts` — `GET .../public` and
   `POST .../mandate` — because the consumer browser never holds a merchant API key and no public
   read/write path existed for it. `POST .../mandate` independently re-verifies the mandate
   on-chain (existence + merchant/asset/payer match) before persisting anything, so it grants no
   authority of its own. 15 new tests in `checkout-sessions.test.ts`. Documented in
   `docs/merchant-api.md` and `docs/threat-model.md`'s new "Phase 10 additions" section.
2. `@fastify/cors` (`origin: true`, global) — without it every browser fetch from `apps/web`'s
   origin to `apps/api`'s origin is blocked by the same-origin policy before it ever reaches the
   new routes. Documented inline in `app.ts` and in `docs/threat-model.md` as a deliberate choice
   (CORS gates browser JS access, not this API's actual bearer-token auth boundary).
3. `packages/contract-client` gained `./client`/`./domain` subpath exports so a browser-bundled
   file (`apps/web`'s `chain-gateway.ts`) can import the client facade without also pulling in the
   root barrel's Node-only `deployment-registry.js` (`node:fs`) — a real `next build` failure the
   first time this was tried, not a hypothetical. `loadDeployment` itself still only runs
   server-side (`app/checkout/[sessionId]/page.tsx`, a Server Component), passed down as a prop.

**Toolchain deviation, discovered mid-phase, not chosen upfront:** `npx shadcn@latest init`'s
current default (`base-nova` preset) generates Tailwind v4-only component syntax
(`--spacing()` theme functions, `@theme inline`) regardless of the pre-existing Tailwind v3 setup
it detected — the first `next build` failed with "unknown utility class `border-border`" and
`node:fs`-in-browser-bundle errors. Migrated `apps/web` from Tailwind v3 to v4
(`@tailwindcss/postcss`, `@import "tailwindcss"` + `@custom-variant dark` in `globals.css`,
`tailwind.config.ts` reduced to a vestigial file `components.json` still points at) rather than
fight the CLI's output — the more correct fix given what the CLI actually generates.

**Test count:** 38 `apps/web` unit/component tests (Vitest + Testing Library — max-exposure/
allowance/format/error-mapping/term-derivation/reducer/terms-list/checkout-flow) + 3 Playwright
tests (happy path; not-found; keyboard-only accessibility with focus-visible assertions). Playwright
stubs both the wallet (`NEXT_PUBLIC_E2E_STUBS=1` swaps in `lib/test-stubs.ts`) and the merchant API
(`e2e/fixtures/mock-api-server.mjs`, plain `node:http` — necessary because the checkout session
fetch happens in a Server Component, which Playwright's browser-level `page.route()` cannot see).
Documented how to run it: `pnpm --filter @paymap/web test:e2e` (`playwright.config.ts` starts both
webServers itself; browsers via `pnpm exec playwright install --with-deps chromium`, already run).

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (10/10 tasks — apps/web: next build succeeds)
pnpm test                            (16/16 tasks; apps/api: 152 tests incl. 15 new;
                                       apps/web: 38 new tests; apps/relayer: 56, unchanged)
pnpm test:e2e                        (apps/web: 3/3 Playwright tests)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token,
                                       unchanged — no contract touched this phase)
```

**Deviations flagged:**

- The 1% fee-headroom basis-point figure is my own judgment call, not a spec-given number (see
  above) — needs lead confirmation.
- `productAssetSymbol` (`checkout-flow.tsx`) renders a short truncated-address placeholder
  ("Asset C1234…5678") instead of a real asset code/symbol — the public product API doesn't carry
  one yet. The full address is always shown alongside in `TermsList` (never hidden), but a real
  asset registry/symbol is deferred, likely Phase 12.
- `packages/ui` (the shared shadcn-component package the repo's own doc comments say should start
  being populated "starting Phase 10") was **not** used — shadcn components were installed directly
  into `apps/web/src/components/ui` instead. `packages/ui` is currently a compiled (`tsc` → `dist`)
  package with no React/JSX/Tailwind wiring, and only one app (`apps/web`) consumes UI so far;
  properly wiring a shared, uncompiled, source-consumed UI package (the idiomatic shadcn monorepo
  pattern) is a real architectural decision better made once Phase 12's merchant dashboard exists
  too and the actual sharing need is concrete, not speculative. Flagged, not silently skipped.

**Unverified / left for later phases:** no real testnet run of the checkout flow (wallet signing
against a live Freighter extension, real Soroban RPC) — explicitly out of this phase's scope per
the brief ("a real testnet run is not required here — Phase 13 owns the full e2e"). The allowance-
change zero-confirm-set-new sequence is proven by a mocked-gateway component test, not against a
real SAC on testnet. `GET /v1/checkout-sessions/:id/public`'s lack of a route-specific rate limit
(beyond the app's global 1000/min/IP default) is flagged in `docs/threat-model.md` for Phase 14.

### Phase 11 — Consumer Dashboard (done)

**What changed:** built `apps/web`'s consumer dashboard (`/dashboard`) end to end. Invoked the
`shadcn` skill (added `tabs`/`progress`/`tooltip` via `npx shadcn@latest add` on top of Phase 10's
`base-nova`/neutral/lucide setup; removed `tooltip.tsx` again once it turned out unused — no
dead-code left behind) and `design-taste-frontend` (declared upfront, per its own Section 13, that
a dashboard is out of scope for its page-composition rules; applied only the cross-cutting quality
bars — no AI-purple/glow, one accent color, dark mode, WCAG AA contrast/focus, real empty/loading/
error states, restrained motion, icon-library discipline).

**Two data sources, one explicit trust hierarchy (CLAUDE.md §2):** a new unauthenticated
`apps/api/src/routes/consumer.ts` (`GET /v1/consumer/mandates`, `GET /v1/consumer/payments`, both
by `payerAddress`) is _discovery/enrichment only_ — merchant display names, asset decimals (via the
existing `resolveAssetDecimalsForMandate`), a `cachedStatus` field deliberately named to signal
"last known, not authoritative". Every field an actual mandate card renders (status, amounts,
period usage, next eligible date) instead comes from a live `get_mandate` simulation call run
directly from the browser (`lib/mandate-gateway.ts`), one per discovered mandate id. Required one
piece of backend wiring discovery depended on: `checkout-sessions.ts`'s `/mandate` link endpoint
(Phase 10) now also upserts `MandateIndex` with the verified payer address — previously only the
merchant-authenticated `GET /v1/mandates/:id` ever wrote that table, and a payer's own browser
never calls that route, so a newly-created mandate would otherwise never be discoverable here. 8 new
`apps/api` tests (`consumer.test.ts`) + 1 new `checkout-sessions.test.ts` assertion.

**New pure/tested logic, `apps/web/src/lib`:**

- `mandate-status.ts` — `deriveEffectiveStatus` (mirrors the contract's lazy-expiry rule, defense
  in depth over an already-computed live read), `computeEffectivePeriodUsage` (the period-usage
  meter uses the _effective_ period at "now", not raw stored fields, so an idle mandate never shows
  a stale "full" reading), `computeNextEligibleChargeDate` (the one PLAN.md §16.1 card field with no
  contract getter at all — two independent gates: the interval floor, and a period-allowance check
  that rolls forward to the next boundary when exhausted; exact for `Fixed`, conservative
  fully-exhausted-only for `Variable` since the next amount is the merchant's future choice),
  `deriveControlAvailability` (Pause/Resume/Cancel-autopay gating mirroring the contract's legal-
  transition table). 22 tests.
- `failure-reasons.ts` — decodes a `ChargeRequest.failureCode` (all 24 frozen contract error codes
  from `packages/stellar`'s own table, plus the relayer's 3 infra-transient reasons) into
  consumer-facing copy framed as _protection working_, not a scary error — distinct from
  `lib/errors.ts`'s checkout-flow copy, which frames the payer's own action failing. 5 tests incl. an
  exhaustive canary over the frozen 24-code table.
- `revoke-flow.ts` — the "cancel autopay" state machine (discriminated union, mirrors
  `checkout-state.ts`'s pattern): revoke → check allowance → (`allowance-prompt` if non-zero,
  straight to `complete` if already zero) → zero-or-skip → `complete`. Declining the prompt is a
  first-class outcome, not an error path. 8 tests.
- `mandate-gateway.ts` — a second, dashboard-scoped gateway alongside Phase 10's `ChainGateway`
  (`getMandate` + payer-signed `pauseMandate`/`resumeMandate`/`revokeMandate`, all via the same
  `submitAsInvoker` flow as `create_mandate`, plus the same `approve`/`queryAllowance` primitives
  reused for the allowance-zero prompt). Kept separate rather than merged into `ChainGateway` since
  the two components' signing lifetimes genuinely differ (once-per-session vs. long-lived
  singleton).

**Components, `apps/web/src/components/dashboard`:** `dashboard-shell` (orchestration: wallet
connect, per-mandate live-read state keyed by id so one mandate's refresh never reloads the whole
list, tab filtering, action dispatch), `dashboard-nav` (shadcn `Tabs`), `mandate-card` (every
PLAN.md §16.1 field + gated controls), `status-badge`, `period-usage-meter` (shadcn `Progress`),
`cancel-autopay-dialog` (drives the revoke-flow reducer's actual gateway calls from a `useEffect`
keyed on `state.phase` alone — several parent props are fresh literals every render, and the effect
must fire exactly once per phase transition or it would re-submit an already-signed transaction),
`payment-history-list` (successes + failed attempts, each failure decoded via `describeFailureReason`),
`wallet-gate`/`empty-state`/`loading-skeleton` (real, explanatory states — never a bare spinner or
"no results"), `settings-panel`.

**Revoke → allowance-zero flow, end to end:** confirm → `revoke_mandate` (payer-signed, immediate
and unconditional per PLAN.md §10.9 — the parent refreshes that mandate's live status the instant
this confirms, before the allowance step even starts) → query current allowance → if non-zero,
prompt "Set your spending approval to zero?" with plain-language reasoning (a lingering allowance is
a standing risk even though the mandate itself now blocks charges) → `approve(amount: 0)` or
**Skip for now** (both reach a `complete` summary; skipping is never treated as an error). Proven by
3 `cancel-autopay-dialog.test.tsx` component tests (mocked gateway) and the Playwright flow.

**Wallet-rejection / stale-state handling (explicit task requirement):** every `pause`/`resume`
failure both surfaces an inline `ErrorBanner` on the card _and_ triggers `refreshMandate` in a
`finally` block — if the mandate's on-chain state changed underneath the user (e.g. it was already
revoked elsewhere), the card's controls re-derive from the fresh read on the next render rather than
staying stale and clickable into a doomed retry.

**Test count:** 47 new `apps/web` unit/component tests (22 `mandate-status`, 8 `revoke-flow`, 5
`failure-reasons`, 9 `mandate-card`, 3 `cancel-autopay-dialog`) — 85 total in `apps/web` now
(up from 38). 3 new Playwright tests in `e2e/dashboard.spec.ts` (list → pause → resume → cancel
autopay → allowance-zero prompt, spanning the Upcoming/Paused & ended tab split; payment history
with a failed-attempt reason; keyboard-only nav + focus-visible) — 6 total in `apps/web` now.
`lib/e2e-stub-fixtures.ts` is the single source of truth for the one fixture mandate id/merchant/
asset shared between the stub `MandateGateway` ("chain") and `e2e/fixtures/mock-api-server.mjs`'s
new consumer routes ("database"); the stub gateway also seeds a realistic non-zero starting
allowance so the E2E test exercises the real prompt, not just its already-zero skip path. 8 new
`apps/api` tests (`consumer.test.ts`) + 1 updated `checkout-sessions.test.ts` — 161 total in
`apps/api` now (up from 152).

**Bug found and fixed along the way (not a Phase 11 feature, a latent Phase 10 gap):**
`apps/web/vitest.setup.ts` never registered `@testing-library/react`'s auto-cleanup — it only
self-registers when a global `afterEach` exists, which requires `vitest.config.ts`'s
`test.globals: true` (not set here; test files import `afterEach`/`describe`/`it` explicitly from
`"vitest"` instead). Every multi-`it()` test file was silently accumulating unmounted DOM across
tests within the same file; it only surfaced once `mandate-card.test.tsx` rendered enough
same-testid elements across tests to trip `getByTestId`'s strict-mode "multiple elements" check.
Fixed once, centrally, in `vitest.setup.ts` (`afterEach(cleanup)`) — benefits every existing and
future component test file, not just the new ones. See `tasks/lessons.md`.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (10/10 tasks — apps/web: next build succeeds, /dashboard
                                       route 36.6 kB / 326 kB First Load JS)
pnpm test                            (16/16 tasks; apps/api: 161 tests incl. 8 new;
                                       apps/web: 85 tests incl. 47 new; apps/relayer: 56, unchanged)
pnpm test:e2e                        (apps/web: 6/6 Playwright tests, 3 new)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token,
                                       unchanged — no contract touched this phase)
```

**Deviations flagged:**

- "Upcoming" and "Active" currently share the same underlying filter (`status === "Active"`,
  different sort — soonest next-eligible-date vs. merchant name) rather than being two visibly
  distinct sets. PLAN.md §16.1 lists them as separate nav items without further specification; this
  is a defensible reading (an "at a glance, what's coming up" view vs. a "manage everything active"
  view) but is a judgment call, not a spec-given distinction — flagged for lead confirmation.
- A paused or just-revoked mandate immediately leaves the Upcoming/Active tab and moves to
  "Paused & ended" (rather than staying visible in place with just its badge updated). This matches
  PLAN.md §16.1's nav split literally and is asserted by the Playwright test, but is a real UX
  choice (some dashboards keep the just-acted-on row in place for continuity) worth a design review.
- `formatAssetSymbol`'s short-address placeholder (carried over from Phase 10, now also used here
  and in the cancel-autopay dialog) still has no real asset code/symbol backing it — unchanged
  Phase 12 deferral, not new to this phase.
- `nowUnixSeconds` (used for lazy-expiry/period-usage/next-eligible display math) is captured once
  per dashboard session (`useState` initializer), not re-ticked on an interval — a long-lived open
  tab could show an increasingly stale "eligible now" window until the next explicit refresh
  (wallet reconnect, action-triggered per-mandate refresh, or a manual page reload). Acceptable for
  this phase's scope; a periodic re-render tick is a reasonable small follow-up, not required by the
  brief.

**Unverified / left for later phases:** no real testnet run of the dashboard's chain reads/writes
(live Freighter, real Soroban RPC) — Phase 13 owns the full real-network e2e. The merchant-side of
Scene 5 (an actual relayer-submitted charge rejected with `MandateRevoked` after cancellation) is
narrated in `docs/demo-script.md` but not re-proven here — it's already covered by Phase 2/3's
contract test suites and Phase 9's relayer classifier; this phase only had to prove the consumer-
facing display/copy for that rejection, which `failure-reasons.test.ts` does.

### Phase 12a — Webhook Delivery + Merchant SDK (done; Phase 12b dashboard UI is a separate agent's slice)

**What changed:** the webhook delivery worker (`apps/relayer`) and `packages/sdk`, per CLAUDE.md
§12 and PLAN.md §17. Did not touch `apps/web` beyond two narrow subpath-import fixes forced by a
`@paymap/shared` barrel change (below) — no dashboard UI work, that's Phase 12b.

**Signing/encryption/SSRF primitives, `packages/shared`** (new, used by both `apps/api` and
`apps/relayer`, and by `packages/sdk` for verification):

- `webhook-signature.ts` — canonical string `{t}.{eventId}.{rawBody}`, HMAC-SHA256,
  `Paymap-Signature: t=…,id=…,v1=…` header, constant-time verify with a tolerance window (default
  300s, both directions).
- `webhook-secret-crypto.ts` — AES-256-GCM, key derived via SHA-256 from `WEBHOOK_ENCRYPTION_KEY`
  (already in the Phase 0 env schema, unused until now), versioned stored format
  `v1:<iv>:<tag>:<ciphertext>`.
- `webhook-url-guard.ts` — SSRF guard: protocol allowlist, IPv4/IPv6 private/loopback/link-local
  range check (incl. IPv4-mapped IPv6 in both dotted and compressed-hex form), injectable DNS
  resolver, and a narrow `allowPrivateAddresses` test-only escape hatch (never set by any
  production code path) so the gate's real-local-receiver test could run in this sandbox.
- 91 new tests in `packages/shared` (55 for these three modules).

**Merchant API additions, `apps/api`:** `POST /v1/webhook-endpoints` (register/rotate a real
webhook URL + secret, secret shown once, encrypted at rest) and `GET /v1/webhook-endpoints`
(status only) — neither existed before; the Phase 8 `/test` endpoint only ever validated a
candidate URL, never persisted one, so there was no way to actually configure a merchant's
delivery target until now. `webhook-state-machine.ts` (new — `WebhookDelivery`'s guarded
transition table, mirrors `state-machine.ts` exactly, reused by `apps/relayer` via the same
deep-import-to-built-output convention as `ChargeRequest`'s). 43 new/updated `apps/api` tests.

**Delivery worker, `apps/relayer`:** new BullMQ queue/worker/scheduler
(`webhook-{queue,worker,scheduler}.ts`, deterministic job id = `webhookDelivery.id`, mirrors the
existing charge pipeline's wiring exactly) driving `webhook-delivery.ts`'s per-row pipeline: guarded
DB claim → decrypt secret → assemble the envelope fresh from the row's own columns (the payload
column stores only event `data`, never a redundant copy of the wrapper) → sign+send
(`webhook-http.ts`, which re-runs the SSRF guard immediately before sending and _pins_ the TCP
connection to the pre-validated address via `undici`'s custom `Agent` lookup, closing the
DNS-rebinding TOCTOU gap; redirects are never followed) → classify
(`webhook-classify.ts`) → transition to `delivered`/`retry_scheduled`/`dead_letter`.
`webhook-retry-schedule.ts`: 1 initial + 5 retries (+1m, +5m, +30m, +2h, +6h, ~8.5h total) then
`dead_letter`. `mandate.completed` wired into the existing charge pipeline (`pipeline.ts`) — the
pipeline already holds the fresh pre-charge `Mandate` read, so a successful charge that brings
`successfulCharges` to exactly `maxSuccessfulCharges` deterministically completed the mandate, no
indexer needed. 102 relayer tests total (46 new: classify, retry-schedule, delivery pipeline incl.
duplicate-delivery/event-id-stability/no-secret-in-payload, scheduler, and the real-HTTP-receiver
gate test).

**`packages/sdk`:** `StellarMandates` client (`checkoutSessions.{create,get}`,
`charges.{create,get}`, `payments.{list,refunds.create}`, `mandates.get`), `verifyWebhook` (thin
wrapper over `@paymap/shared`'s signature module — same logic signer and verifier both use, no
drift possible), typed `StellarMandatesApiError`/`StellarMandatesNetworkError`, and a
type-level-only mirror of the 24 frozen contract error codes (no runtime dependency on
`@paymap/stellar`, which would otherwise pull `@stellar/stellar-sdk` into this small SDK's install
size — a devDependency-only test asserts the two lists never drift). `charges.create` bridges
PLAN.md §17's `invoiceId` (free-form string) to the API's required 32-byte-hex `invoiceHash` via
`sha256(invoiceId)`, deterministically. All mutating calls auto-generate an `Idempotency-Key` when
the caller omits one. 21 new tests.

**Bug found and fixed along the way (not a Phase 12a feature, a pre-existing latent gap the new
`@paymap/shared` barrel exports triggered):** `apps/web`'s `next build` broke —
`node:crypto`/`node:dns`/`node:net` (from the three new webhook modules) reached the browser
bundle through `@paymap/shared`'s root barrel, because a Client Component value-importing
`decimalToBaseUnits`/`baseUnitsToDecimalString` from the bare package specifier drags in the
barrel's _entire_ re-export graph, not just the one function actually used (same class of bug
`packages/contract-client` hit and fixed in an earlier phase — see `tasks/lessons.md`). Fixed by
adding narrow `./money`/`./types` subpath exports to `packages/shared/package.json` and updating
the three `apps/web` call sites (`format.ts`, `mandate-terms.ts`, `payment-history-list.tsx`) to
import from `@paymap/shared/money` instead of the bare specifier — zero behavior change, `apps/web`
build/tests unaffected otherwise.

**Documented, not silently stubbed — 5 of the 8 webhook events have no producer yet:**
`mandate.active`/`paused`/`resumed`/`revoked` are contract calls the payer's wallet submits
directly from `apps/web` (Phase 10/11 checkout + dashboard) — this API never observes them, and
closing that gap needs either a real on-chain event indexer or new backend-notification wiring in
`apps/web` (frontend work outside this phase's slice). `refund.succeeded` has no producer because
no relayer pipeline exists yet that actually _submits_ a refund transaction on-chain (Phase 8's
`POST /v1/payments/:id/refunds` only ever creates a `RefundRequest` row in `scheduled` — there is
no "succeeded" to report). Full detail in `docs/merchant-api.md`'s "which events actually have a
producer today" table. This mirrors the task brief's own explicit anticipation of this gap — not a
surprise finding.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (10/10 tasks — apps/web next build succeeds again post-fix)
pnpm test                            (16/16 tasks; +91 packages/shared, +43 apps/api net,
                                       +46 apps/relayer net, +21 packages/sdk; apps/web unchanged: 85)
pnpm test:e2e                        (apps/web: 6/6 Playwright, unchanged — no web UI touched)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token, unchanged)
```

**Deviations flagged:**

- Signature header is one combined `Paymap-Signature: t=…,id=…,v1=…` value (Stripe-style) rather
  than three separate headers — still carries all three required fields (timestamp, event id,
  signature version) per CLAUDE.md §12, just packed into one header. Documented precisely in
  `docs/merchant-api.md` for cross-language reimplementation.
- `WebhookDelivery.attemptCount`/state transitions have no persisted `failureCode` column (unlike
  `ChargeRequest`) — the classified reason is logged (`webhook_delivery.dead_letter` /
  `.retry_scheduled` structured log events) but not stored on the row. A future phase could add the
  column; not done here to avoid an unrequested schema migration.
- `POST /v1/webhook-endpoints` always issues a brand-new secret on every call (register ==
  rotate) rather than having a separate explicit rotate endpoint — simpler API surface, and matches
  the "only shown once" API-key precedent; flagged in case the lead wants register and rotate to be
  distinct operations.
- `allowPrivateAddresses`/`allowInsecureHttp` test-only flags in the SSRF guard are real, callable
  options on `assertSafeWebhookUrl`/`sendWebhook`/`processWebhookDelivery` (not compiled out) —
  every production call site (`apps/api`'s route, `apps/relayer`'s real worker wiring in `index.ts`)
  omits them, so they default to `false`, but they exist as live code paths. Flagged as a
  judgment call rather than something more invasive (e.g. a separate test-only build target).

**Unverified / left for later phases:** no real testnet/production webhook delivery run (only the
local `node:http` receiver test) — there is no deployed merchant server to POST to yet. The
BullMQ worker/scheduler loop itself was exercised via direct pipeline-function calls
(`processWebhookDelivery`) and a real-Redis queue/scheduler test, not by actually starting
`apps/relayer`'s `index.ts` process end-to-end — matches the existing charge-pipeline testing
convention (`pipeline.test.ts` does the same). Phase 12b (merchant dashboard UI, a separate agent)
will need a way to show webhook delivery status/history to merchants — no UI for that exists yet,
by design (out of this phase's scope).

### Phase 12b — Merchant Dashboard (done)

**What changed:** the merchant dashboard UI (`apps/web/src/app/merchant/**`,
`apps/web/src/components/merchant/**`), per PLAN.md §16.3 and this phase's lead decisions. Nine
nav sections: Products, Checkout links, Mandates, Upcoming, Failed, Payments, Refunds, Developers,
Webhooks — every one backed by a real endpoint, none a placeholder.

**Architecture (the hard requirement — API key never client-side):** `lib/merchant-session.ts`
(httpOnly cookie read/write) and `lib/merchant-api.ts` (typed `/v1/*` client) both start with
`import "server-only"` — a real build-time guarantee, not a convention, that no `"use client"`
file can ever import either module. `lib/no-secret-leak.test.ts` adds a second, faster static
proof (14 tests): scans every Client Component under `app/merchant/**`/`components/merchant/**`
for a _value_ import (type-only imports are erased, not a leak) of either module. Every
`app/merchant/**/page.tsx` is an `async` Server Component (`requireMerchantApiKey()` guard,
`lib/merchant-guard.ts`) reading the key server-side; every mutation is a `"use server"` Server
Action (`lib/merchant-actions.ts`) returning a discriminated `{ok:true,...}|{ok:false,error,...}`
result for `useActionState`. No merchant login system exists (no email/password) — the API key
itself is the identity, stored in an httpOnly/`sameSite:"lax"` cookie set either by
`POST /v1/merchants` (bootstrap, new account) or a verified paste of an existing key.

**Real bug found and fixed during development:** `connect/page.tsx` originally redirected away the
instant a session cookie existed. Next.js re-renders a route's Server Components as part of the
_same_ action response when a Server Action mutates cookies — so `createMerchantAction`'s cookie
write raced the client past the one-time API-key display before it could ever render. Fixed by
making `/merchant/connect` the one page that never guards on cookie presence (documented in its
own module doc) — every other page's guard is unaffected.

**Backend additions (apps/api), flagged and documented, not silent:** PLAN.md §14 only specifies
single-resource merchant reads; rendering PLAN.md §16.3's dashboard needed six new merchant-scoped
`GET` list endpoints — `/v1/products`, `/v1/checkout-sessions`, `/v1/mandates`, `/v1/charges`
(status-filterable), `/v1/refunds`, `/v1/webhook-deliveries` — each mirroring an existing
single-resource read's auth/ownership rules exactly. `GET /v1/mandates` re-reads every listed
mandate live on-chain (never the `MandateIndex` cache alone, CLAUDE.md §2), degrading a single row
to its cached status (`live: false`) rather than failing the whole list if one live read fails.
Documented in `docs/merchant-api.md`'s scope note, same pattern Phase 8's `merchants.ts` addition
used. 6 new/updated `apps/api` route files, 60 new backend tests (218 total now, was ~172 before
counting).

**Reused, not duplicated, business logic (CLAUDE.md §20):** `lib/merchant-mandate-display.ts`'s
`toBigintMandate` converts the API's decimal-string mandate response back into the exact
`bigint`-typed shape Phase 11's `lib/mandate-status.ts` already expects, so "Upcoming collections"
and the mandate detail page's period-usage meter reuse `computeNextEligibleChargeDate`/
`computeEffectivePeriodUsage` verbatim. `components/dashboard/status-badge.tsx`,
`empty-state.tsx`, `period-usage-meter.tsx` reused directly, unchanged. `lib/failure-reasons.ts`
reused for "Failed collections," with an explicit "blocked by mandate rules" vs. "temporary issue"
badge split so a policy rejection is never confused with an infra hiccup.

**Skills invoked:** `shadcn` (added `table`/`select`/`textarea` via the CLI — confirmed
`tailwindVersion: "v4"` via `npx shadcn@latest info --json -c apps/web` first, matching the
existing setup; no new deps needed, all three build on the already-installed `@base-ui/react`) and
`design-taste-frontend` (took only the cross-cutting bars per the lead's note that it scopes itself
to landing pages: no AI-purple/glow, one accent color via the existing shadcn tokens, WCAG AA via
the existing component primitives' built-in focus-visible/contrast styling, real empty/loading/
error states on every list view, dark mode inherited from the existing theme tokens — did not
force landing-page-specific rules like hero/marquee/eyebrow guidance onto a data-dense dashboard).

**Deviations / judgment calls (flagged):**

- No "request a charge" or "submit a refund transaction" UI beyond the refund _request_ form —
  PLAN.md §16.3's dashboard scope is Products/Checkout links/Mandates/Collections/Payments/
  Refunds/Developers/Webhooks, not charge creation (that's the merchant's own backend integration
  via `@paymap/sdk`, PLAN.md §17). `docs/demo-script.md` updated to reflect this precisely.
- No single-payment read endpoint exists on `apps/api` (`GET /v1/payments` is list-only) — the
  refund page finds its target payment by scanning the merchant's own recent payments list rather
  than a dedicated `GET /v1/payments/:id`. Correct (never another merchant's payment can match)
  but not the most efficient possible lookup for a very large payment history; flagged rather than
  silently adding a seventh new backend endpoint beyond the six already justified above.
- The webhook "event coverage" table (which of the 8 events actually produce today) is a static
  constant in `app/merchant/webhooks/page.tsx`, hand-mirrored from `docs/merchant-api.md`'s table
  rather than fetched from a shared source — there's no backend endpoint for "event producer
  status" (it's not really data, it's documentation of current wiring), and inventing one just to
  avoid a hand-mirrored constant would be over-engineering for an MVP.
- `GET /v1/mandates`'s live-read-per-row approach (`Promise.all`, capped at `limit`, default 25) is
  the same N+1-live-read pattern already established by `payments.ts`/`charges.ts`'s decimals
  resolution — consistent with existing convention, not a new architectural pattern, but a real
  scalability ceiling for a merchant with very many mandates (acceptable for this MVP's scale).

**Tests:** 45 new `apps/web` tests (130 total, was 85) — `merchant-product-form.test.ts` (13, incl.
over-precision rejection and fixed/variable branching), `merchant-refund-form.test.ts` (8, incl.
`amount <= remaining refundable` enforcement), `no-secret-leak.test.ts` (14, the security proof),
`product-form.test.tsx`/`create-merchant-form.test.tsx`/`refund-form.test.tsx` (10 component tests
using RTL + `userEvent`, mocking `lib/merchant-actions` and verifying `useActionState` + native
`<form action>` actually invokes the mocked server action in jsdom). Plus 60 new `apps/api` tests
for the six list endpoints (listed above). New `e2e/merchant.spec.ts` (2 tests): the full flow
(create account -> create product -> generate checkout link -> view mandate -> view a failed
collection with its reason -> rotate API key) plus a keyboard/focus-visible accessibility pass.
`e2e/fixtures/mock-api-server.mjs` extended with merchant routes, keyed by a `Map<apiKey, account>`
(not one shared object) — an earlier single-`merchant`-variable version produced real cross-test
401s under Playwright's `fullyParallel: true` the first time a second merchant test ran
concurrently with the happy-path test's own key-rotation step; caught by running the suite twice,
not by inspection.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (10/10 tasks)
pnpm test                            (16/16 tasks; apps/api 218, apps/web 130, apps/relayer 102,
                                       packages/* unchanged)
pnpm test:e2e                        (apps/web: 8/8 Playwright — 6 pre-existing + 2 new merchant,
                                       run twice to confirm no parallel-worker flakiness)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token, unchanged)
```

**Unverified / left for later phases:** no real testnet run of the merchant dashboard against a
live `apps/api` + Postgres + real Soroban RPC — only the Playwright suite against the mock API and
the `apps/api` route tests against a real (local) Postgres with a fake `MandateReader`. The 4
`mandate.*` webhook events still have no producer (Phase 12c, on-chain event indexer — unchanged by
this phase, correctly reflected as "Not wired yet" in the dashboard's event-coverage table rather
than silently implied). No pagination UI for any list view (all currently render up to their
endpoint's `limit` in one page) — acceptable for this MVP's expected scale, flagged for a future
phase if a merchant's history grows large.

---

## Phase 12c — On-chain event indexer

**Goal:** give the 4 producer-less `mandate.*` webhook events (`mandate.active`/`mandate.paused`/
`mandate.resumed`/`mandate.revoked`) a real producer by polling Soroban RPC's `getEvents` for the
mandate-registry contract's own lifecycle events, and stop `MandateIndex` from going stale when a
payer acts directly from their wallet.

- [x] `packages/contract-client/src/events.ts` (+ `./events` subpath export) — decodes the 5
      `#[contractevent]`s into a typed `MandateLifecycleEvent` union. Verified against
      `soroban-sdk-macros-27.0.2`'s actual wire format: topics contain name, mandate ID, payer,
      and merchant; data is a field-name-keyed `ScvMap`.
- [x] `packages/stellar/src/events.ts` — `fetchMandateLifecycleEvents`/`getCurrentLedgerSequence`,
      thin `rpc.Server.getEvents()` wrapper, imports `contract-client`'s `./events` subpath (not
      root) to avoid dragging `node:fs` into any browser bundle.
- [x] `prisma/schema.prisma`: `IndexerCursor` model (one global row) — durable poll-cursor
      persistence, deliberately separate from `MandateIndex.lastIndexedLedger` (per-mandate).
      Migration `20260728230751_phase12c_indexer_cursor`.
- [x] `apps/relayer/src/indexer/`: `chain-events-gateway.ts` (injected seam), `cursor.ts` (CAS
      persistence), `mandate-index-sync.ts` (chain-wins atomic upsert + deterministic webhook
      enqueue + merchant resolution/isolation + cold-start asset backfill), `indexer.ts` (one tick:
      fetch -> retention-gap check -> apply events in order -> advance cursor), `scheduler.ts`
      (`setInterval` loop, wired into `apps/relayer/src/index.ts` alongside the existing
      charge/webhook schedulers).
- [x] `apps/relayer/src/webhook.ts`: added `enqueueDeterministicWebhook` (idempotent
      `createMany({skipDuplicates:true})` variant of the existing `enqueueChargeWebhook`) — reused by
      the indexer, no second webhook mechanism.
- [x] Event -> webhook map: `mandate_created`->`mandate.active`, `mandate_paused`->`mandate.paused`,
      `mandate_resumed`->`mandate.resumed`, `mandate_revoked`->`mandate.revoked`. `mandate_completed`
      deliberately maps to **no** webhook — the charge pipeline (Phase 12a) is the sole producer,
      already synchronous and already tested; the indexer only updates `MandateIndex.status` to
      `"Completed"` for that event.
- [x] Deterministic event id: `chain:<rpc event id>` (Soroban RPC's own event id — ledger/tx/
      operation/event-index derived, never random) — the `WebhookDelivery.eventId` unique constraint
      is the backstop for exactly-once webhook production across reprocessing/concurrent indexers.
- [x] Docs: `docs/architecture.md` (new "Phase 12c" section), `docs/merchant-api.md` (event
      catalogue + producer table updated), `apps/web/src/app/merchant/webhooks/page.tsx`'s
      `EVENT_PRODUCER_STATUS` table flipped to `producing: true` for the 4 events.

**Tests:** 17 new `apps/relayer` tests (119 total, was 102) — `indexer/mandate-index-sync.test.ts`
(10: unknown-merchant skip, create+enqueue, reuse-existing-merchant, chain-wins monotonic-ledger
guard, same-event reprocess idempotency, two-concurrent-applies idempotency, merchant isolation,
`mandate_completed` no-webhook, no-duplicate-with-pipeline, cold-start asset backfill) and
`indexer/indexer.test.ts` (7: first-run lookback arithmetic, cursor resume after "restart",
tick-level idempotency, same-ledger ordering, two-concurrent-indexer-instances overlapping range,
two retention-gap paths — thrown RPC error and advanced-`oldestLedger`). Plus 11 new
`packages/contract-client` tests (`events.test.ts`) decoding all 5 lifecycle events from
`nativeToScVal`-built fixtures matching the macro's real wire shape, plus unrecognized-event/
malformed-shape error cases. All against a real Postgres (`docker-compose.yml`), fake chain
gateways — no live RPC in the default `pnpm test` run.

**Real-testnet verification (`scripts/verify-indexer-testnet.ts`, actually run):** created a fresh
mandate (`create_mandate` tx `e549dad8ef009151ca0e5dc063b02b79673927720f2a9f391a1713b85d9bd2ef`,
mandate id `566f42dd4ff53cdbad4d526609d6156a82460ee14273af5308b74947512bf30d`), immediately paused it
(`pause_mandate` tx `eb6d148932fd373944232bebbc9e8802282cb4b7a93bc5f687840837b07c5383`), then ran the
real `runIndexerTick` (`createSorobanChainEventsGateway`, real Soroban RPC, no fake) against real
testnet. Result: both events decoded and applied in one tick (`mandate_created` rpc event id
`0016545579823816704-0000000000`, `mandate_paused` rpc event id `0016545584118796288-0000000000`),
producing `MandateIndex.status = "Paused"` and exactly one `mandate.active` + one `mandate.paused`
`WebhookDelivery` row (`pending`, correct merchant, `eventId` = `chain:<rpc event id>`). Full JSON
output captured in this phase's session transcript.

**Commands run (all passed):**

```
docker compose up -d
pnpm install
pnpm lint                            (16/16 tasks)
pnpm typecheck                       (16/16 tasks)
pnpm build                           (10/10 tasks — required fixing a real `next build` break, see
                                       "Deviations" below)
pnpm test                            (16/16 tasks; apps/relayer 119 [was 102], contract-client 23
                                       [was 12], everything else unchanged)
pnpm test:e2e                        (apps/web: 8/8 Playwright, unchanged)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace               (136 mandate-registry [1 ignored] + 9 mock-token, unchanged —
                                       no contract changes this phase)
```

**Deviations / decisions:**

- Chose **`IndexerCursor` as its own table** over `MandateIndex.lastIndexedLedger` — the poll cursor
  is a single global property of the whole contract's event stream, not per-mandate; folding it into
  a per-row field would mean every mandate row redundantly (and potentially inconsistently) carrying
  the same global value.
- **Retention-gap detection is heuristic on the error-message path** (pattern-matches common Soroban
  RPC wording) — this repo's contract is only ~2 days old, so a genuinely 7-day-stale cursor's exact
  error text was never observed against live infrastructure. The second, response-shape-based check
  (`oldestLedger` advancing past the stored `lastLedger`) is response-format-independent and is the
  one to trust more; both are tested with a fake gateway, neither against a real induced gap.
- **No new required or optional env vars** — poll interval (15s), initial lookback (100 ledgers),
  and page size (100) are code-level defaults passed as `IndexerDeps`/`startIndexerScheduler`
  parameters, not `process.env` reads. Kept deliberately minimal per this phase's scope; revisit if
  operators need to tune them without a code change.
- Adding `packages/stellar/src/events.ts` (which depends on `@paymap/contract-client`'s root export)
  to `packages/stellar/src/index.ts`'s barrel broke `apps/web`'s `next build`
  (`UnhandledSchemeError: Reading from "node:fs"`) — the same "barrel re-exports a Node-only sibling"
  failure mode `tasks/lessons.md` already documents, recurring one layer up (`packages/stellar`'s own
  barrel, not just `contract-client`'s). Fixed by adding a `./events` subpath export to
  `packages/contract-client/package.json` and importing that instead of the root — confirmed by a
  clean `pnpm build` afterward. Lesson appended to `tasks/lessons.md`.

**Unverified / left for later phases:** the true "cursor fell outside the RPC's ~7-day retention
window" scenario was never triggered against real infrastructure (would require a cursor that is
actually days stale) — the heuristic error-matching path is untested against a real error string,
only against a synthetic one in `indexer/indexer.test.ts`. `refund.succeeded` still has no producer
(needs a relayer refund-execution pipeline, out of this phase's scope). No pagination or UI surface
for indexer-produced events specifically beyond the existing webhook-deliveries list.

---

## Phase 16 — Production Readiness

### Plan

#### 1. Non-custodial merchant authorization transport — release blocker

- [x] Add `ChargeAuthorization` persistence with merchant/charge binding, unsigned challenge XDR,
      signed authorization-entry XDR, network, contract, expiry ledger, single-use status, and
      timestamps. Encrypt the usable signed XDR at rest with a dedicated key.
- [x] Split charge creation into a two-step API:
      `POST /v1/mandates/:id/charge-authorizations` validates fresh chain state, fixes
      `chargeId`/amount/invoice/schedule, simulates once to obtain the exact invocation tree, and
      returns the Soroban authorization preimage plus display fields;
      `POST /v1/charge-authorizations/:id/complete` verifies the merchant signature and atomically
      creates the scheduled `ChargeRequest`.
- [x] Add a merchant SDK helper that checks network, contract, method, signer, mandate, charge,
      amount, invoice hash, and expiry before requesting wallet/backend signature. No secret key
      crosses the API boundary.
- [x] Rebuild the relayer transaction from DB-bound charge fields, attach only the stored signed
      authorization entry before simulation, then retain the existing simulation/result
      verification and relayer envelope-signing flow.
- [x] Enforce authorization expiry, merchant ownership, exact invocation matching, one
      authorization per charge, one-time consumption, and fail-closed behavior for missing,
      malformed, replayed, or expired XDR.
- [x] Add unit/integration/live-testnet coverage for valid transport, altered amount/destination/
      invoice/contract/network, wrong signer, replay, expiry, concurrent consumption, relayer
      restart, and no merchant secret in API/relayer storage or logs.

#### 2. Persistent metrics and alerts

- [x] Replace snapshot-only observability with Prometheus-compatible counters, gauges, and
      histograms exposed by API and relayer HTTP endpoints; keep the existing `Observability`
      interface as the application seam.
- [x] Add persistent Prometheus storage, Alertmanager, dashboards, health/readiness endpoints, and
      staging scrape configuration.
- [x] Alert on API/relayer down, permanent charge failures, elevated retry/simulation/RPC failure
      rates, settlement latency, webhook dead letters, indexer lag/retention gaps, queue backlog,
      auth rejection anomalies, and API-key abuse.
- [x] Add metric-label cardinality guards: never label by merchant, mandate, charge, transaction,
      URL, secret, or raw error text.
- [x] Verify restart durability, alert-rule syntax, health/readiness semantics, and one synthetic
      firing/resolution path.

#### 3. Scoped API keys and permissions

- [x] Add API-key name, immutable scopes, last-used timestamp, and migration of existing keys to
      full legacy access.
- [x] Define stable scopes:
      `products:{read,write}`, `checkout_sessions:{read,write}`, `mandates:read`,
      `charges:{read,write}`, `payments:read`, `refunds:{read,write}`,
      `webhooks:{read,write}`, and `api_keys:manage`.
- [x] Extend auth prehandlers to require declared scopes and return stable `INSUFFICIENT_SCOPE`
      errors without leaking resource existence.
- [x] Add list/create/revoke key endpoints. Preserve scopes during rotation unless explicitly
      replaced by a caller holding `api_keys:manage`; show raw keys once.
- [x] Wire every merchant route to least privilege; update dashboard/SDK/docs.
- [x] Test every route/scope pair, cross-merchant isolation, revoked keys, migration defaults,
      self-revocation safety, and privilege-escalation attempts.

#### 4. Nightly system E2E in CI

- [x] Add scheduled and manually dispatchable GitHub Actions workflow for
      `pnpm test:e2e:system` against Stellar testnet with Postgres/Redis services, Playwright
      Chromium, concurrency control, timeout, artifact upload, and secret-safe logs.
- [x] Keep pull-request CI deterministic; nightly live-network failures must not weaken normal CI.
- [ ] Add failure notification through the selected alert destination and document required
      repository secrets.

#### 5. Staging deployment

- [x] Add minimal production Dockerfiles for web, API, relayer, and migration job; run as non-root,
      use health checks, immutable images, graceful shutdown, and no build-time secrets.
- [x] Add staging infrastructure/config for managed Postgres and Redis, persistent monitoring,
      TLS frontend/API, private relayer/metrics networking, secret injection, migration-before-
      rollout, backup/restore, rollback, and separate testnet relayer account.
- [x] Deploy the demo frontend to Vercel and combined API/relayer to Render Free; provision
      Postgres/Key Value, fund a dedicated testnet relayer, run migrations, and verify health.
- [ ] Run the full system E2E against deployed URLs and record final load/failure evidence.

#### 6. Load and failure testing

- [ ] Add reproducible load scenarios for API reads, idempotent charge authorization creation/
      completion, scheduler throughput, queue backlog, webhook bursts, and metrics endpoints.
- [ ] Add controlled failure scenarios for RPC timeout/5xx, Redis restart, Postgres connection
      loss, relayer kill during each state transition, webhook 5xx/timeout, expired auth, and
      indexer lag.
- [x] Define staging safety limits and pass/fail budgets before execution: no double charge,
      no lost terminal state, bounded recovery time, bounded p95/p99 latency, zero secret leakage,
      and alerts fire/resume as expected.
- [ ] Run baseline, load, soak, and failure tests on staging; store reports and document bottlenecks,
      tuned limits, residual risks, rollback, and operator runbooks.

### Verification

- [x] `pnpm security:audit`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm test`
- [x] `pnpm test:e2e`
- [x] `pnpm test:e2e:system`
- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace --all-targets -- -D warnings`
- [x] `cargo test --workspace`
- [x] Prisma migration tested from current schema and a clean database
- [x] Docker images build and run as non-root; health/readiness checks pass
- [x] Prometheus config/rules and Alertmanager config validate
- [ ] Nightly workflow validates and manual dispatch passes
- [x] Deployed frontend/API smoke checks pass
- [ ] Deployed system E2E, load, soak, failure, backup/restore, and rollback checks pass
- [x] Inspect `git diff` and confirm no unrelated changes or tracked secrets

### Files likely touched

- `prisma/schema.prisma`, `prisma/migrations/*`
- `packages/config/src/*`, `packages/stellar/src/*`, `packages/sdk/src/*`
- `apps/api/src/{app,index,auth,routes,schemas,services}/*`
- `apps/relayer/src/{index,config,chain-gateway,pipeline,observability}*`
- `apps/web/src/{app,components,lib}/*`
- `.github/workflows/{ci,system-e2e-nightly}.yml`
- `Dockerfile*`, `docker-compose*.yml`, `.dockerignore`, `ops/**/*`, `scripts/**/*`
- `.env.example`, `README.md`, `docs/{architecture,merchant-api,threat-model,security-checklist,operations}.md`

### Questions

- [x] Architecture checkpoint: approve signed Soroban authorization-entry XDR transport,
      Prometheus/Alertmanager, and the scope set above.
- [x] Render selected; custom domain not required and alert email deferred. Dedicated testnet
      relayer created and funded during deployment.

### Review

#### Changed

- Added encrypted, invocation-bound merchant authorization transport and transparent SDK signing.
- Added scoped API keys, persistent Prometheus/Alertmanager/Grafana monitoring, nightly live E2E,
  Render staging infrastructure, production containers, runbooks, and bounded load/failure probes.

#### Verified

- Live Stellar testnet flow passed: checkout, mandate, signed non-custodial charge, webhook,
  history, revoke, and deterministic `MandateRevoked` rejection.
- Secret audit, lint, typecheck, builds, 642 TypeScript tests, 8 browser E2E tests, and 148 Rust
  tests passed.
- Final API/web/relayer image runs as non-root. Redis failure returned readiness 503 in 2.6 ms and
  recovered to 200. Local 2,000-request load probe: 0 failures, p95 2.91 ms.
- Prometheus config and 13 rules, synthetic firing/resolution, Alertmanager, and Actions workflow
  syntax validated.
- Vercel frontend is live at `https://paymap-web.vercel.app`; Render API/relayer is live at
  `https://paymap-demo-api.onrender.com`. `/healthz`, `/readyz`, `/metrics`, `/merchant`, and
  `/dashboard` returned 200.
- Render sequential load probe: 100 requests, 0 failures, p95 133.02 ms.

#### Risks

- Render Free fails the 5-concurrency load budget: 500 requests, 16.4% platform-edge `404` responses
  with `x-render-routing: no-server`, p95 130.32 ms for completed requests. Application logs show
  handled requests completing with 200 and no process crash. Deployed E2E/soak remains incomplete.
- Free Render Postgres expires after 30 days and has no backups; free Key Value is nonpersistent;
  the web service sleeps after inactivity. This deployment is demo-only.
- Submitted transactions with an unknown final ledger outcome alert for manual reconciliation;
  automatic submitted-state reconciliation remains follow-up work.

#### Follow-ups

- Configure alert email later, per product decision.

---

## Phase 17 — Level 5 Submission

### Plan

- [x] Audit public repo, commit count, deployment, transaction evidence, and missing submission items.
- [x] Create a professional pitch deck covering problem, solution, market, architecture, growth,
      roadmap, and demo.
- [x] Create an Excel feedback-analysis workbook for real Google Form exports; do not fabricate users
      or responses.
- [x] Add onboarding/feedback form specification and evidence collection instructions.
- [x] Update README with live app, pitch deck, workbook, feedback iteration plan, commit links,
      transaction proof, demo-video placeholder, and Level 5 checklist.
- [x] Verify deck visuals, workbook formulas/layout, README links, repository gates, and clean diff.

### Verification

- [x] Repository public and 20+ meaningful commits
- [x] Deck renders without overflow or overlap
- [x] Workbook has no formula errors and all sheets render legibly
- [x] README links resolve locally
- [x] `pnpm exec prettier --check README.md docs/level-5/*.md tasks/todo.md`
- [x] `git diff --check`

### Review

#### Changed

- Added a nine-slide editable Level 5 pitch deck with presenter notes and source links.
- Added a formula-backed Excel workbook for genuine Google Form exports, including validation,
  duplicate-wallet highlighting, readiness gates, and a rating chart.
- Added the exact Google Form specification, privacy/export rules, evidence tracker, and README
  submission section.

#### Verified

- Public repository; 20+ commits before this phase and 21 after the artifact commit.
- Deck rendered to nine slide images, visually inspected as a contact sheet, and passed
  `slides_test.py`.
- All three workbook sheets rendered; formula inspection contained no spreadsheet errors.
- Frontend returned HTTP 200; Render API `/readyz` responded after the free-tier cold start.
- Prettier and `git diff --check` passed.

#### Risks

- Level 5 is not honestly complete until 50 genuine users, verified per-user testnet activity, a
  published demo video, analytics screenshots, and a product commit based on observed feedback exist.
- The empty workbook is a collection/analysis tool, not user-growth proof.

#### Follow-ups

- Create the Google Form from the committed specification and collect the real cohort.
- Paste or import the genuine export, verify transactions, and publish only redacted/aggregate proof.
- Record/upload the walkthrough, implement the highest-impact observed issue, and add both links to
  README.

---

## Phase 18 - Landing Page

### Plan

- [x] Audit the production root route, existing brand tokens, routes, shadcn configuration, and
      frontend dependencies.
- [x] Replace the Phase 0 stub with a responsive AIDA landing page using the requested design skills.
- [x] Add a project-owned hero visual and isolated GSAP motion with reduced-motion fallbacks.
- [x] Compose existing shadcn primitives for navigation actions, proof cards, and conversion CTAs.
- [x] Add focused landing-page tests and update metadata.
- [x] Verify lint, typecheck, tests, build, desktop/mobile visuals, reduced motion, copy rules, and
      clean diff.

### Verification

- [x] `pnpm --filter @paymap/web lint`
- [x] `pnpm --filter @paymap/web typecheck`
- [x] `pnpm --filter @paymap/web test`
- [x] `pnpm --filter @paymap/web build`
- [x] Desktop and mobile screenshots inspected
- [x] No placeholder copy, em dashes, horizontal overflow, or broken CTA routes
- [x] `git diff --check`

### Review

#### Changed

- Replaced the Phase 0 root stub with a complete responsive landing page.
- Added two original Paymap visuals, an honest merchant-product screenshot, and WebP optimization.
- Added GSAP hero, reveal, word-scrub, and sticky-stack motion with reduced-motion fallbacks.
- Reworked semantic theme tokens around one cobalt accent and composed shadcn Button, Badge, Card,
  and Separator primitives.
- Added landing-page metadata and a focused route/copy regression test.

#### Verified

- Lint and typecheck pass.
- Web test suite passes: 19 files, 133 tests.
- Production build passes; `/` is statically rendered.
- Desktop light/dark and mobile screenshots inspected; desktop hero is exactly two lines and page
  width equals viewport width.
- Sticky title and card stack verified after fixing the overflow ancestor.
- Production Lighthouse: performance 97, accessibility 100, best practices 96, SEO 100; CLS 0 and
  total blocking time 10 ms.

#### Risks

- The merchant screenshot reflects the current minimal merchant connection screen; replace it after
  that product surface receives its own visual redesign.

#### Follow-ups

- Push the branch and allow Vercel to redeploy the new root route.

---

## Phase 19 - Merchant Wallet Authentication

### Plan

- [x] Add single-use, expiring merchant wallet challenges and opaque dashboard sessions.
- [x] Verify Freighter signed messages against the configured Stellar network and exact challenge.
- [x] Authenticate existing merchants by wallet; require verified wallet ownership before creating
      a new merchant profile.
- [x] Remove unauthenticated merchant bootstrap and API-key-as-dashboard-login behavior.
- [x] Keep legacy API keys working for integrations while moving list/create/revoke scoped keys
      into Developers.
- [x] Replace merchant onboarding with connect wallet, sign in, and new-profile completion states.
- [x] Update architecture, merchant API docs, environment examples, and focused security tests.
- [x] Apply the Prisma migration, deploy API/web, and smoke-test the live authentication surface.

### Verification

- [x] Prisma migration applies to clean and current schemas
- [x] API auth/challenge/session/scoped-key tests pass
- [x] Web merchant onboarding and Developers tests pass
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm test`
- [x] `git diff --check`
- [x] Render API ready and Vercel merchant routes return 200

### Files likely touched

- `prisma/schema.prisma`, `prisma/migrations/*`
- `apps/api/src/auth/*`, `apps/api/src/routes/merchants*`, `apps/api/src/schemas/merchants*`
- `apps/web/src/app/merchant/*`, `apps/web/src/components/merchant/*`
- `apps/web/src/lib/{merchant-actions,merchant-api,merchant-guard,merchant-session}*`
- `.env.example`, `docs/{architecture,merchant-api,threat-model}.md`

### Questions

- [x] Architecture: wallet-signed challenge for human sessions; scoped API keys remain
      server-to-server credentials.

### Review

#### Changed

- Replaced API-key dashboard login with Freighter wallet ownership challenges and 24-hour
  httpOnly-backed merchant sessions.
- Removed public merchant bootstrap; new profiles now require a verified payout wallet.
- Added scoped integration-key list/create/revoke controls under Developers while preserving
  existing API-key integrations.
- Added challenge/session persistence, a production migration, configuration, docs, and E2E
  coverage.
- Bundled public contract deployment data into web server artifacts so Vercel merchant, checkout,
  and dashboard routes do not depend on build-time filesystem paths.

#### Verified

- Prisma migration applied to both existing API and relayer test schemas; schema validation passes.
- All 640 package tests and 8 Playwright flows pass.
- Lint, typecheck, production build, and `git diff --check` pass.
- Render is live on the wallet-auth commit; the challenge endpoint returns the expected Vercel
  domain and the removed public merchant-bootstrap endpoint returns 404.
- Vercel merchant sign-in and dashboard return 200; Developers redirects unauthenticated users to
  wallet sign-in.

#### Risks

- Render's free service can cold-start slowly after inactivity.

#### Follow-ups

- None.

---

## Phase 23 - Main Branch CI Repair

### Plan

- [x] Inspect the failing GitHub Actions run on `main`.
- [x] Reproduce the failed web build with the CI environment.
- [x] Add the missing non-secret web build configuration to CI.
- [x] Run the affected local gates and inspect the diff.
- [x] Commit and push the web-build fix to `main`.
- [x] Pass CI database and Redis configuration through Turbo strict mode.
- [x] Run the full Node test gate with CI-equivalent variables.
- [x] Commit and push the test-environment fix to `main`.
- [x] Verify the new GitHub Actions run passes.

### Verification

- [x] `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 pnpm build`
- [x] `pnpm lint`
- [x] CI-equivalent `pnpm test`
- [x] `git diff --check`
- [x] GitHub Actions `CI` succeeds on `main`

### Files likely touched

- `.github/workflows/ci.yml`
- `turbo.json`
- `tasks/todo.md`
- `tasks/lessons.md`

### Review

#### Changed

- Added an explicit non-secret API URL to the Node CI job so Next.js can validate and compile the
  frontend from a clean checkout.
- Declared database and Redis variables as Turbo global task inputs so strict environment filtering
  preserves them for integration tests.

#### Verified

- Reproduced the build failure with an empty API URL.
- The full workspace build passes with the CI API URL, and lint plus diff checks pass.
- The first repair run passed Rust, Node lint, typecheck, and build, then exposed Turbo stripping
  `DATABASE_URL` before API tests.
- Turbo dry-run reports hashed database and Redis inputs, and all 640 Node tests pass with
  CI-equivalent variables against local Postgres and Redis.
- GitHub Actions run `30532651748` passed both Node and Rust jobs on `main`.

#### Risks

- GitHub emits a non-blocking warning that current action releases target deprecated Node 20
  action runtimes; the workflow itself runs Node 24 for actions and Node 22 for project commands.

#### Follow-ups

- Upgrade GitHub action major versions when their Node 24 releases are available and stable.

---

## Phase 22 - Main Branch Release Gate

### Plan

- [x] Fetch remote refs and inspect divergence from `main`.
- [x] Run lint, typecheck, unit/integration tests, builds, E2E, Rust checks, and repository audits.
- [x] Fix any failures at their root and rerun affected/full checks.
- [x] Commit the completed gate, merge production readiness into current `main`, and push.
- [x] Verify remote `main` contains the merge and the worktree is clean.

### Verification

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `pnpm test:e2e`
- [x] `pnpm test:e2e:system`
- [x] `pnpm security:audit`
- [x] `pnpm prisma:validate`
- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace --all-targets -- -D warnings`
- [x] `cargo test --workspace`
- [x] `git diff --check`

### Files likely touched

- `tasks/todo.md`
- Any files required to fix failing checks

### Review

#### Changed

- Made Prisma validation deterministic when both supported local env files define `DATABASE_URL`.
- Added the release gate and its verification record.

#### Verified

- All JavaScript/TypeScript lint, typecheck, test, build, browser E2E, security, and Prisma gates
  pass.
- Browser E2E passes 8/8.
- Real Stellar testnet system E2E passes checkout, authorized charge, signed webhook, history,
  revocation, and `MandateRevoked` protection.
- Rust formatting, clippy with warnings denied, and all workspace tests pass.

#### Risks

- None known. Remote `main` had no divergent commits, and the merge completed without conflicts.

#### Follow-ups

- None.

---

## Phase 20 - Testnet Transaction Stress Run

### Plan

- [x] Validate the deployed testnet contract, asset, RPC, Horizon, and live API.
- [x] Add a bounded CLI-driven stress runner using fresh payer and merchant accounts.
- [x] Fund 12 accounts, establish PUSD trustlines/balances/allowances, and create 7 mandates.
- [x] Execute 7 merchant-authorized charges through the production API and relayer.
- [x] Verify about 52 unique testnet transaction hashes and all final charge/mandate states.
- [x] Save a public evidence report containing addresses, hashes, timings, and failures only.

### Verification

- [x] Script lint and typecheck
- [x] 12 distinct funded Stellar addresses
- [x] About 52 successful, unique testnet transactions
- [x] 7 relayed charges succeed on-chain
- [x] Evidence report contains no secret keys or session credentials
- [x] `git diff --check`

### Files likely touched

- `scripts/stress-test-testnet.ts`
- `scripts/package.json`
- `docs/level-5/evidence/testnet-stress-*.csv`
- `tasks/todo.md`

### Questions

- [x] Scope: controlled Stellar testnet only; activity is stress-test evidence, not real-user proof.

### Review

#### Changed

- Added a reusable opt-in testnet stress runner with isolated temporary CLI identities, bounded
  allowances, wallet-authenticated merchant sessions, production API charge authorization, live
  relayer execution, Horizon verification, and secret-free CSV evidence.
- Submitted and verified 52 intended testnet transactions across 7 payer and 5 merchant accounts:
  12 Friendbot fundings, 12 trustlines, 7 asset fundings, 7 allowances, 7 mandates, and 7 charges.

#### Verified

- All 52 intended hashes are unique and successful in Horizon.
- All 7 charge requests reached `succeeded`; each mandate reports one successful charge and
  1,000,000 base units collected.
- Script typecheck/lint, evidence assertions, secret scan, and `git diff --check` pass.

#### Risks

- A stopped preflight attempt funded one additional disposable account before detecting a missing
  explicit CLI network passphrase. No trustline, allowance, mandate, or charge followed; the
  corrected run therefore produced about 53 total testnet transactions including that funding.
- These are controlled load accounts, not genuine onboarded users.

#### Follow-ups

- Use the evidence report for technical stress proof only; collect 50 real users separately.

---

## Phase 21 - CSV Transaction Evidence

### Plan

- [x] Replace the JSON stress artifact with a one-row-per-transaction CSV.
- [x] Make future testnet stress runs emit CSV directly.
- [x] Update README and task documentation to reference the CSV artifact.

### Verification

- [x] CSV contains 52 data rows and 52 unique valid transaction hashes
- [x] Every row includes phase, source address, and Stellar Expert link
- [x] Script lint and typecheck
- [x] JSON artifact removed
- [x] `git diff --check`

### Files likely touched

- `scripts/stress-test-testnet.ts`
- `docs/level-5/evidence/testnet-stress-20260730045306-585217.csv`
- `README.md`
- `tasks/todo.md`

### Review

#### Changed

- Replaced the stress-run JSON with a spreadsheet-ready CSV containing one transaction per row.
- Updated the stress runner and README to emit and link CSV evidence by default.

#### Verified

- CSV has 52 data rows, 52 unique 64-character hashes, and eight fields per row.
- Phase totals remain 12 fundings, 12 trustlines, 7 asset fundings, 7 allowances, 7 mandates, and
  7 relayed charges.
- Every row is marked successful and includes its source address and direct Stellar Expert URL.
- Script lint/typecheck, secret scan, JSON-removal check, and `git diff --check` pass.

#### Risks

- The CSV intentionally contains only public testnet metadata.

#### Follow-ups

- None.
