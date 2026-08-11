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

- [ ] `create_mandate(input) -> BytesN<32>` — `payer.require_auth()`, validate all bounds (positive amounts, `expires_at > start_at`, `period_seconds > 0`, `max_per_period >= max_per_charge`), reject duplicate id
- [ ] `pause_mandate`, `resume_mandate`, `revoke_mandate` — payer auth, legal-transition table only
- [ ] `get_mandate` — lazy `Expired` evaluation on read (PLAN.md §10.8), does not persist-write on read path
- [ ] Events: `mandate_created`, `mandate_paused`, `mandate_resumed`, `mandate_revoked`, `mandate_expired`
- [ ] Tests: success, wrong-signer rejection per method, resume-from-revoked rejection, revoke-from-completed, pause idempotency

**Gate:** `cargo test --workspace`.

**Invariants:** §7 Authorization (payer-only), §7 State (revocation immediate, no merchant approval).

**Decision needed:** does lazy expiry write status on next *write* interaction, or stay computed-only? Recommend computed-only + `Expired` derived in reads; avoids storage write on read path.

---

## Phase 3 — Fixed Charge Execution

**Goal:** first money movement. Full validation order.

- [ ] `charge(mandate_id, charge_id, amount, invoice_hash) -> PaymentReceipt`
- [ ] `merchant.require_auth()` — never relayer
- [ ] Implement validation order 1–14 exactly per CLAUDE.md §6, in that sequence
- [ ] Fixed rule: `amount == fixed` else `AmountExceedsChargeLimit` / `InvalidAmount`
- [ ] `min_interval_seconds` check vs `last_charged_at`
- [ ] Duplicate `charge_id` → `DuplicateCharge`
- [ ] SAC `transfer_from(spender=contract, from=payer, to=merchant, amount)`
- [ ] Update accounting **after** transfer only: `successful_charges`, `total_collected`, `current_period_collected`, `last_charged_at`, receipt store, event emit
- [ ] `get_payment`
- [ ] `charge_succeeded` event with full field set (PLAN.md §11)
- [ ] Tests: success, wrong-merchant, before start, after expiry, too soon, duplicate charge id, paused, revoked, wrong amount, insufficient allowance, insufficient balance, transfer-failure rollback

**Gate:** `cargo test --workspace` w/ `mock-token` incl. a panicking/failing token variant for rollback test.

**Invariants:** §7 Amounts (fixed exact), §7 Time (all three), §7 Replay (`charge_id` once), §7 Tokens (merchant receives exactly, contract retains nothing), §6 accounting rollback.

**Stop condition:** if Soroban `transfer_from` failure does not unwind sub-invocation state as assumed → stop, report, do not work around.

---

## Phase 4 — Variable Charge + Period Accounting

**Goal:** capped variable billing, period rollover correct.

- [ ] `AmountRule::Variable { max_per_charge }` enforcement
- [ ] `period_index = floor((now - start_at) / period_seconds)`; on index change reset `current_period_collected = 0`, set `current_period_start` to computed boundary (not `now`)
- [ ] `max_per_period` remaining-allowance check
- [ ] `max_successful_charges` → transition `Completed` + `mandate_completed` event
- [ ] Tests: variable success, over per-charge cap, over per-period cap, two charges same period summing to cap, period rollover resets, skipped-period boundary (long gap), charge exactly at boundary second, max count reached → completed → next charge rejected

**Gate:** `cargo test --workspace`.

**Invariants:** §7 Amounts (period total), §7 Time (period reset exactly once per period).

**Explicit test:** boundary at `t = start_at + n*period_seconds` — assert reset happens at `>=`, not `>`.

---

## Phase 5 — Refunds

- [ ] `refund(mandate_id, payment_id, amount, refund_id) -> RefundReceipt` — merchant auth
- [ ] Cumulative `refunded_total[payment_id]`; `refunded + amount <= payment.amount` else `RefundExceedsPayment`
- [ ] `refund_id` replay guard → `DuplicateRefund`
- [ ] Transfer merchant → payer; accounting only after success
- [ ] `refund_succeeded` event
- [ ] Decide: does refund decrement `total_collected` / `current_period_collected`? **Recommend no** — refunds do not restore spending headroom (prevents refund-cycle cap bypass). Document in `docs/contract-invariants.md`.
- [ ] Tests: full, partial, partial×2 to exact total, over-refund, duplicate refund id, refund on revoked mandate (should still work), refund unknown payment

**Gate:** `cargo test --workspace`.

**Invariants:** §7 Amounts (refund ≤ payment), §7 Replay (`refund_id` once).

---

## Phase 6 — Invariant & Property Tests

**Goal:** prove §7 holds under random action sequences.

- [ ] Property harness: random ops `create|charge|pause|resume|revoke|refund|advance_time`
- [ ] Assert after every op: all 22 PLAN.md §18 invariants
- [ ] Key oracle: `successful_charges == count(stored receipts)`
- [ ] Key oracle: `sum(receipts in period) <= max_per_period`
- [ ] Key oracle: contract token balance == 0 after every op
- [ ] Adversarial: malicious token contract (reentrant `transfer_from`, lying return, balance drain)
- [ ] Write `docs/contract-invariants.md` — every invariant → the test that proves it

**Gate:** `cargo test --workspace` incl. property suite.

**This phase is the security bar. Do not skip to Phase 7 with failures.**

---

## Phase 7 — Deploy + Contract Client

- [ ] `scripts/deploy-testnet.ts` — build, optimize, deploy, record contract id
- [ ] Deployment registry JSON keyed by network
- [ ] `packages/contract-client` — generated bindings + typed wrapper (i128 ↔ bigint, never `number`)
- [ ] `packages/stellar` — tx builder, simulation helper, auth-entry assembly, error-code → typed error decoder
- [ ] `packages/shared` — Zod schemas, decimal-string ↔ base-unit conversion (reject over-precision), shared mandate types
- [ ] `scripts/create-demo-mandate.ts` — creates + charges a mandate on testnet

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
