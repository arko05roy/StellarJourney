# Stellar Mandates — PLAN.md

## 1. Product Summary

**Stellar Mandates** is a non-custodial recurring-payment and debit-authorization layer for Stellar.

A user authorizes a merchant once, but the merchant can only collect funds within explicit on-chain rules such as:

- Maximum amount per charge.
- Maximum amount per billing period.
- Minimum time between charges.
- Approved payment asset.
- Start and expiry time.
- Maximum number of successful charges.
- Optional pre-debit notification period.
- Optional user approval above a threshold.
- Immediate pause or revocation by the user.

The merchant never receives unrestricted access to the user’s wallet. Every collection request is validated by a Soroban mandate contract before funds move.

The product should feel like **UPI AutoPay or card-on-file subscription management**, but with transparent limits, non-custodial control, stablecoin settlement, passkey-friendly onboarding, and merchant APIs.

---

## 2. Core Problem

Recurring payments on crypto rails are usually handled poorly:

1. Users manually sign every payment.
2. Users grant unsafe unlimited token allowances.
3. Merchants build custom subscription logic from scratch.
4. Users cannot see or manage all active mandates in one place.
5. Variable billing and usage billing have weak consumer protections.
6. Failed payments, retries, refunds, and cancellations are inconsistent.
7. Seed phrases and gas management make normal consumer onboarding difficult.

Stellar Mandates solves this with a reusable authorization standard, Soroban contracts, a relayer, merchant SDKs, and a consumer dashboard.

---

## 3. Product Positioning

> **Approve once. Pay automatically. Stay in control.**

Stellar Mandates is not merely a subscription app. It is payment infrastructure that wallets, SaaS products, marketplaces, creator platforms, AI services, and payroll tools can integrate.

### Primary users

- Consumers paying recurring subscriptions.
- SaaS merchants charging fixed or variable plans.
- Marketplaces collecting recurring platform fees.
- Creator platforms handling memberships.
- AI services charging usage-based fees.
- Wallets that want a standard mandate-management experience.

### Initial merchant examples

- $15 monthly software subscription.
- Up to $25 monthly storage bill.
- Six installments of $100 each.
- $5 monthly creator membership.
- Usage billing capped at $10 per day and $50 per month.

---

## 4. MVP Scope

The MVP should prove one complete recurring-payment flow on Stellar testnet.

### MVP mandate types

#### A. Fixed recurring mandate

Example:

```text
Charge exactly $15 USDC
At most once every 30 days
Maximum 12 successful charges
Expires after 12 months
```

#### B. Variable capped mandate

Example:

```text
Charge up to $25 USDC
At most once every 30 days
Maximum $25 per billing period
Pre-debit notice required 24 hours before collection
```

#### C. Installment mandate

Example:

```text
Charge $100 USDC every 30 days
Stop after 6 successful charges
```

### MVP user actions

- Connect a Stellar wallet.
- Create a mandate from a merchant checkout page.
- Review all mandate terms before authorization.
- Approve the token allowance required by the mandate.
- View active, paused, completed, expired, and revoked mandates.
- Pause a mandate.
- Resume a paused mandate.
- Revoke a mandate immediately.
- View charge history.
- View failed charge attempts and reasons.

### MVP merchant actions

- Create a merchant profile.
- Create a subscription product.
- Generate a mandate checkout link.
- Request a collection.
- View mandate status.
- View payment history.
- Receive webhook events.
- Issue a full or partial refund.

### MVP protocol actions

- Validate a mandate before every charge.
- Enforce per-charge limits.
- Enforce billing-period limits.
- Enforce minimum time between charges.
- Enforce start and expiry times.
- Enforce maximum charge count.
- Prevent duplicate charge IDs.
- Transfer the approved token amount.
- Record an immutable payment receipt.
- Support pause, resume, revoke, and complete states.

---

## 5. Explicit Non-Goals for MVP

Do not build the following in the first version:

- Fiat on-ramp or off-ramp integrations.
- Live SEP-24, SEP-31, or SEP-38 anchor integrations.
- Automatic path-payment conversion between arbitrary assets.
- Cross-chain payments.
- Decentralized dispute arbitration.
- Credit or overdraft.
- Chargeback insurance.
- A protocol token.
- Governance.
- Production mainnet deployment.
- Fully private payment amounts.
- Complex per-request x402 billing.
- Multiple merchants under one mandate.

These may be added after the fixed and variable mandate flows are secure and reliable.

---

## 6. Product Principles

1. **No unlimited authorization by default.**
2. **The user must understand the maximum possible debit.**
3. **Revocation must be immediate and unconditional.**
4. **The relayer must not be trusted with user funds.**
5. **Merchants may request a payment but cannot bypass mandate rules.**
6. **Every charge must be replay-safe and idempotent.**
7. **The contract, indexer, and UI must agree on mandate state.**
8. **A failed collection must never partially mutate accounting state.**
9. **The interface should resemble a familiar consumer billing app, not a DeFi dashboard.**
10. **Security and invariant correctness are more important than feature count.**

---

## 7. Recommended Technology Stack

### Frontend

- Next.js App Router.
- TypeScript with strict mode.
- Tailwind CSS.
- shadcn/ui.
- React Hook Form.
- Zod.
- TanStack Query.
- Zustand only for small client-only state.
- Stellar Wallets Kit or a compatible Stellar wallet connector.
- Passkey smart-wallet support as an optional second integration.

### Backend and relayer

- Node.js with TypeScript.
- Fastify or Next.js route handlers for the MVP.
- PostgreSQL.
- Prisma ORM.
- BullMQ with Redis for scheduled charge jobs.
- A dedicated Soroban transaction builder and simulation service.
- Webhook delivery worker with signed events and retries.

### Smart contracts

- Rust.
- Soroban SDK.
- Stellar Asset Contract interface for token allowance and transfer operations.
- Contract events for all state transitions.

### Development tooling

- pnpm workspaces.
- Turborepo.
- Vitest.
- Playwright.
- Rust unit tests.
- Soroban local sandbox tests.
- GitHub Actions.
- Docker Compose for PostgreSQL and Redis.

---

## 8. Monorepo Structure

```text
stellar-mandates/
├── apps/
│   ├── web/                       # Consumer and merchant web app
│   ├── api/                       # REST API, webhooks, merchant auth
│   └── relayer/                   # Scheduled charge executor
├── contracts/
│   ├── mandate-registry/          # Main Soroban mandate contract
│   └── mock-token/                # Test-only token contract if required
├── packages/
│   ├── contract-client/           # Generated and wrapped Soroban clients
│   ├── sdk/                       # Merchant TypeScript SDK
│   ├── shared/                    # Shared types, Zod schemas, constants
│   ├── ui/                        # Shared UI components
│   ├── stellar/                   # Transaction builders and simulation
│   └── config/                    # ESLint, TSConfig, environment helpers
├── prisma/
│   └── schema.prisma
├── scripts/
│   ├── deploy-testnet.ts
│   ├── seed-demo.ts
│   └── create-demo-mandate.ts
├── docs/
│   ├── architecture.md
│   ├── contract-invariants.md
│   ├── merchant-api.md
│   ├── threat-model.md
│   └── demo-script.md
├── PLAN.md
├── CLAUDE.md
├── README.md
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 9. System Architecture

```text
┌──────────────────────────────┐
│ Consumer / Merchant Web App  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ API and Merchant Platform    │
│ - Products                   │
│ - Checkout sessions          │
│ - Charge requests            │
│ - Webhooks                   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Relayer and Scheduler        │
│ - Due mandate jobs           │
│ - Preflight simulation       │
│ - Transaction submission     │
│ - Retry classification       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Soroban Mandate Contract     │
│ - Authorization rules        │
│ - Usage accounting           │
│ - Pause/revoke state         │
│ - Token transfer execution   │
│ - Immutable events           │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Stellar Asset Contract       │
│ - approve                    │
│ - allowance                  │
│ - transfer_from              │
└──────────────────────────────┘
```

### Trust model

- The mandate contract is the final policy authority.
- The relayer is untrusted and only submits transactions.
- The merchant cannot transfer funds directly through the protocol.
- The backend database is an index and workflow layer, not the source of truth.
- The user’s wallet signs mandate creation, changes, and token approval.
- The merchant signs or authenticates collection requests through the API.

---

## 10. Soroban Contract Design

### 10.1 Main contract

Create one `mandate-registry` contract that stores mandates and processes collections.

### 10.2 Mandate identifier

Each mandate should have a deterministic or collision-resistant identifier:

```text
mandate_id = hash(
  network_id,
  contract_address,
  payer,
  merchant,
  asset,
  client_nonce
)
```

The user or checkout flow supplies a unique `client_nonce`.

### 10.3 Core types

```rust
pub enum MandateStatus {
    Active,
    Paused,
    Revoked,
    Completed,
    Expired,
}

pub enum AmountRule {
    Fixed(i128),
    Variable { max_per_charge: i128 },
}

pub struct Mandate {
    pub id: BytesN<32>,
    pub payer: Address,
    pub merchant: Address,
    pub asset: Address,
    pub status: MandateStatus,
    pub amount_rule: AmountRule,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub min_interval_seconds: u64,
    pub start_at: u64,
    pub expires_at: u64,
    pub max_successful_charges: u32,
    pub successful_charges: u32,
    pub total_collected: i128,
    pub current_period_start: u64,
    pub current_period_collected: i128,
    pub last_charged_at: Option<u64>,
    pub created_at: u64,
    pub metadata_hash: BytesN<32>,
}
```

Use ledger timestamp rather than ledger sequence for user-facing billing windows unless the Soroban environment requires a safer abstraction.

### 10.4 Public contract methods

```rust
create_mandate(mandate_input) -> BytesN<32>
pause_mandate(mandate_id)
resume_mandate(mandate_id)
revoke_mandate(mandate_id)
charge(mandate_id, charge_id, amount, invoice_hash) -> PaymentReceipt
refund(mandate_id, payment_id, amount, refund_id) -> RefundReceipt
get_mandate(mandate_id) -> Mandate
get_payment(payment_id) -> PaymentReceipt
```

### 10.5 Authorization requirements

- `create_mandate`: payer authorization required.
- `pause_mandate`: payer authorization required.
- `resume_mandate`: payer authorization required.
- `revoke_mandate`: payer authorization required.
- `charge`: merchant authorization or verified merchant delegate authorization required.
- `refund`: merchant authorization required.

Do not rely on the relayer address as merchant authorization.

### 10.6 Charge validation order

The contract should validate in a deterministic order before any token transfer:

1. Mandate exists.
2. Mandate status is active.
3. Current time is at or after `start_at`.
4. Current time is before `expires_at`.
5. Merchant authorization is valid.
6. `charge_id` has not been used.
7. Amount is positive.
8. Amount satisfies the fixed or variable rule.
9. Minimum interval has elapsed.
10. Maximum successful charge count is not exceeded.
11. Current billing period is calculated or rolled forward.
12. Amount does not exceed remaining period allowance.
13. Token allowance is sufficient.
14. Payer balance is sufficient.
15. Transfer executes successfully.
16. Accounting state is updated.
17. Payment receipt is stored.
18. Charge event is emitted.

All state updates must revert if the token transfer fails.

### 10.7 Billing period handling

Avoid cron-like calendar semantics in the contract during the MVP.

Use fixed-duration periods:

```text
period_index = floor((now - start_at) / period_seconds)
```

When the current period index differs from the stored index:

- Reset `current_period_collected` to zero.
- Set the current period start to the computed boundary.

Calendar-month billing can be added off-chain later while preserving an on-chain maximum-duration safety rule.

### 10.8 Completion logic

A mandate becomes `Completed` when:

- `successful_charges == max_successful_charges`, if the maximum is non-zero.
- Or a fixed installment schedule reaches its count.

A mandate becomes `Expired` lazily during the next read or write interaction when `now >= expires_at`.

### 10.9 Revocation behavior

Revocation must:

- Be immediately effective.
- Prevent all future charge attempts.
- Not require merchant approval.
- Not delete payment history.
- Emit a `mandate_revoked` event.

The frontend should also guide the user to set the token allowance to zero when appropriate.

### 10.10 Allowance strategy

For the MVP, the payer should approve a bounded allowance to the mandate contract.

Recommended allowance:

```text
remaining theoretical mandate maximum + small explicit fee allowance
```

Never default to an unlimited allowance.

When changing an existing allowance, follow the safer sequence:

1. Set allowance to zero.
2. Confirm the previous allowance is no longer usable.
3. Set the new allowance.

The contract must still enforce mandate rules even if the token allowance is larger than the remaining mandate maximum.

---

## 11. Contract Events

Emit structured events for indexers and merchant webhooks.

```text
mandate_created
mandate_paused
mandate_resumed
mandate_revoked
mandate_completed
mandate_expired
charge_succeeded
charge_failed_policy_check   # optional; do not emit for reverted calls if impossible
refund_succeeded
```

Each successful charge event should include:

```text
mandate_id
payment_id
charge_id
payer
merchant
asset
amount
invoice_hash
period_index
successful_charge_number
timestamp
```

Do not emit sensitive plaintext metadata. Store hashes and keep descriptive metadata off-chain.

---

## 12. Payment and Refund Receipts

### Payment receipt

```rust
pub struct PaymentReceipt {
    pub payment_id: BytesN<32>,
    pub mandate_id: BytesN<32>,
    pub charge_id: BytesN<32>,
    pub payer: Address,
    pub merchant: Address,
    pub asset: Address,
    pub amount: i128,
    pub invoice_hash: BytesN<32>,
    pub timestamp: u64,
}
```

### Refund receipt

```rust
pub struct RefundReceipt {
    pub refund_id: BytesN<32>,
    pub payment_id: BytesN<32>,
    pub amount: i128,
    pub timestamp: u64,
}
```

Track cumulative refunded amount per payment to prevent over-refunds.

---

## 13. Backend Data Model

The database is an indexed mirror plus merchant workflow state.

### Suggested entities

#### User

- `id`
- `walletAddress`
- `email` optional
- `createdAt`

#### Merchant

- `id`
- `name`
- `walletAddress`
- `apiKeyHash`
- `webhookUrl`
- `webhookSecret`
- `status`
- `createdAt`

#### Product

- `id`
- `merchantId`
- `name`
- `description`
- `assetAddress`
- `amountType`
- `fixedAmount`
- `maxPerCharge`
- `maxPerPeriod`
- `periodSeconds`
- `minIntervalSeconds`
- `maxSuccessfulCharges`
- `defaultDurationSeconds`
- `active`

#### CheckoutSession

- `id`
- `merchantId`
- `productId`
- `clientReference`
- `payerAddress` optional before connection
- `expiresAt`
- `status`

#### MandateIndex

- `mandateId`
- `payerAddress`
- `merchantAddress`
- `assetAddress`
- `status`
- `contractStateVersion`
- `lastIndexedLedger`
- `lastIndexedAt`

#### ChargeRequest

- `id`
- `merchantId`
- `mandateId`
- `chargeId`
- `amount`
- `invoiceHash`
- `scheduledFor`
- `status`
- `attemptCount`
- `failureCode`
- `transactionHash`

#### Payment

- `paymentId`
- `mandateId`
- `chargeId`
- `amount`
- `assetAddress`
- `transactionHash`
- `ledger`
- `createdAt`

#### WebhookDelivery

- `id`
- `merchantId`
- `eventType`
- `payload`
- `attemptCount`
- `nextAttemptAt`
- `status`

---

## 14. Merchant API

Use versioned REST endpoints for the MVP.

### Authentication

- Merchant API key for server-to-server calls.
- Hash stored API keys.
- Show full key only once.
- Support key rotation.

### Endpoints

```text
POST   /v1/products
GET    /v1/products/:id
POST   /v1/checkout-sessions
GET    /v1/checkout-sessions/:id
GET    /v1/mandates/:id
POST   /v1/mandates/:id/charges
GET    /v1/charges/:id
POST   /v1/payments/:id/refunds
GET    /v1/payments
POST   /v1/webhook-endpoints/test
```

### Idempotency

Require an `Idempotency-Key` header for:

- Creating checkout sessions.
- Creating charge requests.
- Creating refunds.

Persist the request hash and response. Reject reuse with a different body.

### Webhook events

```text
mandate.active
mandate.paused
mandate.resumed
mandate.revoked
mandate.completed
payment.succeeded
payment.failed
refund.succeeded
```

Sign webhook payloads with HMAC SHA-256 and include:

- Event ID.
- Event timestamp.
- Signature version.
- Retry count.

---

## 15. Relayer and Scheduler

The relayer is responsible for transaction execution, not policy authority.

### Relayer responsibilities

1. Find due charge requests.
2. Load current on-chain mandate state.
3. Build the Soroban contract invocation.
4. Simulate the transaction.
5. Classify deterministic failures before submission.
6. Submit the transaction.
7. Wait for final result.
8. Persist the transaction hash and ledger.
9. Trigger merchant webhooks.
10. Retry only transient failures.

### Failure classification

#### Permanent failures

- Mandate revoked.
- Mandate paused.
- Mandate expired.
- Charge exceeds maximum.
- Charge submitted too early.
- Maximum charge count reached.
- Duplicate charge ID.

Do not retry automatically.

#### Potentially recoverable failures

- Insufficient payer balance.
- Insufficient allowance.
- Temporary RPC failure.
- Temporary network congestion.
- Transaction timeout.

Retry under an explicit schedule and merchant policy.

### Retry policy

Suggested MVP policy:

```text
Attempt 1: scheduled time
Attempt 2: +6 hours
Attempt 3: +24 hours
Attempt 4: +72 hours
Then mark unpaid
```

Do not retry after mandate revocation or expiry.

---

## 16. Frontend Experience

### 16.1 Consumer dashboard

Primary navigation:

- Upcoming.
- Active mandates.
- Payment history.
- Paused and ended.
- Settings.

Each mandate card should show:

- Merchant name.
- Asset.
- Fixed amount or maximum amount.
- Billing frequency.
- Next eligible charge date.
- Period usage.
- Expiry.
- Status.

Primary controls:

- Pause.
- Resume.
- Revoke.
- View history.

### 16.2 Checkout flow

1. Merchant checkout link opens.
2. User sees product and merchant identity.
3. Wallet connects.
4. Exact mandate terms are displayed.
5. UI shows the maximum possible exposure.
6. User approves mandate creation.
7. User approves bounded token allowance.
8. Confirmation screen displays mandate ID and next possible charge date.

### 16.3 Merchant dashboard

- Products.
- Checkout links.
- Active mandates.
- Upcoming collections.
- Failed collections.
- Payments.
- Refunds.
- Developers.
- Webhooks.

### 16.4 UX language

Prefer familiar terms:

- “Automatic payment” instead of “token allowance.”
- “Maximum charge” instead of “spend cap.”
- “Cancel autopay” instead of “revoke mandate” in consumer UI.
- Show the technical term secondarily when useful.

Never hide the asset, maximum amount, frequency, or expiry.

---

## 17. SDK Design

Create a small TypeScript SDK.

```ts
import { StellarMandates } from "@stellar-mandates/sdk";

const mandates = new StellarMandates({
  apiKey: process.env.STELLAR_MANDATES_API_KEY!,
});

const checkout = await mandates.checkoutSessions.create({
  productId: "prod_monthly_ai",
  clientReference: "customer_123",
  successUrl: "https://merchant.example/success",
  cancelUrl: "https://merchant.example/cancel",
});
```

Charge request:

```ts
await mandates.charges.create({
  mandateId: "mandate_...",
  amount: "15.00",
  asset: "USDC",
  invoiceId: "invoice_2026_08_001",
  idempotencyKey: "invoice_2026_08_001",
});
```

The SDK should expose typed error codes and webhook verification utilities.

---

## 18. Security Invariants

These invariants must be documented and tested.

### Authorization invariants

1. Only the payer can create, pause, resume, or revoke their mandate.
2. Only the authorized merchant or delegate can request a charge.
3. The relayer cannot change charge amount or merchant destination.

### Amount invariants

4. No successful charge can exceed `max_per_charge`.
5. Fixed mandates can only charge the exact fixed amount.
6. Total charges in a period cannot exceed `max_per_period`.
7. Total collected cannot exceed the theoretical mandate maximum when such a maximum is defined.
8. Refunds cannot exceed the original payment amount.

### Time invariants

9. A charge cannot occur before `start_at`.
10. A charge cannot occur after expiry.
11. Two charges cannot be closer than `min_interval_seconds`.
12. Period accounting must reset exactly once per new period.

### State invariants

13. Paused, revoked, completed, or expired mandates cannot be charged.
14. A used `charge_id` can never succeed again.
15. A used `refund_id` can never succeed again.
16. Failed token transfers cannot advance mandate accounting.
17. Revocation does not erase receipts or history.
18. Successful charge count equals the number of stored successful payment receipts.

### Token invariants

19. The merchant receives exactly the charged amount.
20. The payer loses exactly the charged amount, excluding explicit network fees paid separately.
21. The contract must never retain user payment funds unintentionally.
22. A malicious token contract must not cause inconsistent mandate accounting.

---

## 19. Threat Model

### Threat: Unlimited token approval

Mitigation:

- Use bounded approvals.
- Display maximum exposure.
- Support allowance reset during cancellation.

### Threat: Merchant replay attack

Mitigation:

- Unique `charge_id`.
- Idempotency keys.
- On-chain used-charge tracking.

### Threat: Relayer manipulation

Mitigation:

- Contract validates merchant, amount, asset, and mandate terms.
- Relayer does not control destination.

### Threat: Double charge around period boundary

Mitigation:

- Contract computes period index from canonical time.
- State transition and charge occur atomically.

### Threat: Merchant charges immediately after revocation

Mitigation:

- Revocation is on-chain and checked in the same transaction as collection.
- Backend state is never trusted over contract state.

### Threat: Front-running

Mitigation:

- Merchant destination and amount are mandate-bound.
- `charge_id` is unique.
- A copied transaction cannot redirect funds.

### Threat: Malicious invoice metadata

Mitigation:

- Store only fixed-size hashes on-chain.
- Sanitize all off-chain metadata.

### Threat: Compromised merchant API key

Mitigation:

- On-chain amount and timing caps remain effective.
- API key rotation.
- Optional merchant signing key.
- Rate limits and anomaly detection.

### Threat: Webhook spoofing

Mitigation:

- Signed webhooks.
- Timestamp validation.
- Replay protection.

---

## 20. Testing Strategy

### 20.1 Contract unit tests

Test at minimum:

- Successful fixed charge.
- Successful variable charge.
- Charge above per-charge maximum.
- Charge above period maximum.
- Charge before start.
- Charge after expiry.
- Charge too soon after previous charge.
- Duplicate charge ID.
- Charge while paused.
- Charge after revocation.
- Charge after completion.
- Incorrect merchant authorization.
- Insufficient allowance.
- Insufficient balance.
- Period rollover.
- Maximum charge count.
- Full refund.
- Partial refund.
- Over-refund attempt.
- Duplicate refund ID.
- Token transfer failure rollback.

### 20.2 Property and invariant tests

Use randomized action sequences:

```text
create → charge → pause → resume → charge → refund → revoke
```

Assert the security invariants after every action.

### 20.3 Backend tests

- API authentication.
- Idempotency behavior.
- Charge state machine.
- Retry classification.
- Webhook signatures.
- Duplicate event handling.
- Database transaction safety.

### 20.4 End-to-end tests

Use Playwright and Stellar testnet or local Soroban:

1. Merchant creates product.
2. Consumer opens checkout.
3. Consumer signs mandate and allowance.
4. Merchant creates charge request.
5. Relayer simulates and submits charge.
6. Merchant receives webhook.
7. Consumer sees payment history.
8. Consumer revokes mandate.
9. New charge attempt fails.

### 20.5 Adversarial tests

- Relayer changes amount.
- Merchant changes asset.
- Merchant reuses charge ID.
- Two workers submit the same charge concurrently.
- Charge and revocation are submitted close together.
- Period boundary race.
- RPC returns stale simulation data.
- Webhook receiver returns repeated errors.

---

## 21. Observability

Track:

- Active mandates.
- Successful charge rate.
- Failure rate by reason.
- Average settlement time.
- Relayer simulation failure rate.
- RPC latency.
- Webhook success rate.
- Retry count.
- Duplicate charge attempts prevented.
- Total payment volume by asset.

Use structured logs with:

- `mandateId`
- `chargeId`
- `merchantId`
- `transactionHash`
- `requestId`

Never log private keys, API keys, or complete webhook secrets.

---

## 22. Delivery Milestones

### Milestone 0 — Repository foundation

- Initialize pnpm and Turborepo.
- Create apps and packages.
- Add strict TypeScript configuration.
- Add Rust workspace.
- Add Docker Compose for PostgreSQL and Redis.
- Add CI for lint, typecheck, test, and Rust formatting.

**Verification:** all empty applications build successfully in CI.

### Milestone 1 — Mandate contract core

- Implement mandate storage.
- Implement create, pause, resume, and revoke.
- Add contract events.
- Add authorization tests.

**Verification:** payer-only actions are enforced and state transitions are correct.

### Milestone 2 — Charge execution

- Implement fixed and variable amount rules.
- Implement period accounting.
- Implement interval and expiry checks.
- Integrate token `transfer_from`.
- Add payment receipts.

**Verification:** all amount, timing, and replay invariants pass.

### Milestone 3 — Refunds and completion

- Implement partial and full refunds.
- Prevent over-refunds.
- Implement completed and expired states.

**Verification:** randomized state-machine tests pass.

### Milestone 4 — Contract client and deployment

- Generate TypeScript bindings.
- Deploy to Stellar testnet.
- Add deployment registry.
- Add transaction simulation helpers.

**Verification:** a script creates and charges a test mandate on testnet.

### Milestone 5 — Merchant backend

- Merchant accounts and API keys.
- Products and checkout sessions.
- Charge request API.
- Idempotency.
- PostgreSQL schema.

**Verification:** API integration tests pass.

### Milestone 6 — Relayer

- Job scheduling.
- Contract state loading.
- Preflight simulation.
- Submission and confirmation.
- Failure classification.
- Retry behavior.

**Verification:** one scheduled payment executes end-to-end on testnet.

### Milestone 7 — Consumer checkout and dashboard

- Wallet connection.
- Mandate review.
- Contract signature flow.
- Bounded allowance flow.
- Active mandate list.
- Pause, resume, and cancel autopay.
- Payment history.

**Verification:** a new user can complete the full flow without CLI use.

### Milestone 8 — Merchant dashboard and webhooks

- Products.
- Checkout links.
- Mandate list.
- Charge list.
- Webhook endpoint configuration.
- Signed webhook delivery.

**Verification:** a sample merchant app receives `payment.succeeded`.

### Milestone 9 — Security hardening

- Threat-model review.
- Contract invariant audit.
- Concurrency tests.
- Rate limits.
- Secret handling review.
- Allowance-cancellation UX.

**Verification:** no open critical or high-severity findings in the internal checklist.

### Milestone 10 — Demo polish

- Seed merchant and customer accounts.
- Add sample fixed and variable plans.
- Build a clear transaction timeline.
- Add a failed over-limit charge demo.
- Add immediate revocation demo.
- Produce demo script and architecture diagram.

**Verification:** the complete demo can be run from a clean environment with one documented command sequence.

---

## 23. Hackathon Demo Script

### Scene 1 — Merchant setup

A merchant creates:

```text
CloudBox Pro
Up to $20 USDC every 30 days
24-hour pre-debit notice
Expires after 12 months
```

The dashboard generates a checkout link.

### Scene 2 — Consumer authorization

The user opens the link and sees:

- Merchant identity.
- Maximum charge.
- Frequency.
- Expiry.
- Maximum possible yearly debit.

The user signs the mandate and bounded allowance.

### Scene 3 — Successful collection

The merchant requests a $14.50 charge.

The relayer:

- Loads the mandate.
- Simulates the transaction.
- Executes it.
- Emits the receipt.
- Sends a webhook.

The merchant receives $14.50 USDC.

### Scene 4 — Policy protection

The merchant attempts to charge $25.

The contract rejects it because the mandate maximum is $20.

### Scene 5 — User control

The user taps **Cancel autopay**.

A later valid-looking $10 charge is rejected because the mandate is revoked.

### Final message

> Merchants receive programmable recurring stablecoin payments. Users retain hard on-chain limits and instant cancellation.

---

## 24. Post-MVP Roadmap

### Phase 2

- Pre-debit notification commitments.
- Usage-based billing.
- User approval above a threshold.
- Merchant delegates and key rotation.
- Multi-asset checkout.
- Payment links and QR mandates.
- Passkey smart-wallet onboarding.

### Phase 3

- Exact-receive path payments.
- Customer pays in one asset, merchant receives another.
- Anchor-assisted merchant settlement.
- Cross-border recurring payroll and subscriptions.
- Refund routing across assets.

### Phase 4

- x402 and MPP spending mandates for AI agents.
- Per-request and per-session limits.
- Merchant reputation.
- Fraud and anomaly detection.
- Optional payment protection and rolling reserves.

### Phase 5

- Wallet integration standard.
- Open mandate metadata specification.
- Merchant certification.
- Mainnet security audit.
- Production deployment.

---

## 25. Definition of Done for MVP

The MVP is complete only when:

1. The Soroban contract is deployed on Stellar testnet.
2. A user can create a bounded fixed or variable mandate through the web UI.
3. A merchant can request a charge through an authenticated API.
4. A relayer can execute a due payment without custodying user funds.
5. The contract rejects over-limit, early, duplicate, paused, revoked, and expired charges.
6. Payment receipts are indexed and visible in both dashboards.
7. The user can revoke a mandate and prevent all future collections.
8. Merchant webhooks are signed and retried safely.
9. Contract and end-to-end tests cover all critical invariants.
10. The demo can be reproduced from documented setup instructions.

