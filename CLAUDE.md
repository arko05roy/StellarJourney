# CLAUDE.md — Stellar Mandates

This file defines the operating rules for coding agents working on **Stellar Mandates**.

The project is a non-custodial recurring-payment and debit-authorization protocol on Stellar. Users authorize merchants once, but every collection remains constrained by explicit Soroban-enforced rules.

Read `PLAN.md` before making architectural or product decisions.

---

## 1. Core Objective

Build a secure MVP in which:

1. A merchant creates a recurring-payment product.
2. A user creates an on-chain mandate with explicit limits.
3. The user grants only a bounded token allowance.
4. A merchant requests a payment through an authenticated API.
5. An untrusted relayer submits the charge transaction.
6. The Soroban contract validates every rule and transfers the token.
7. The user can pause, resume, or revoke the mandate.
8. The merchant receives signed webhook events.

The contract is the policy authority. The database is never the final source of truth.

---

## 2. Non-Negotiable Product Rules

- Never implement unlimited token approvals as the default.
- Never allow the relayer to choose or alter the merchant destination.
- Never trust backend mandate status without verifying on-chain state before a charge.
- Never process a charge without an idempotent `charge_id`.
- Never update charge accounting before confirming token transfer success.
- Never permit a paused, revoked, completed, or expired mandate to be charged.
- Never hide the maximum charge, frequency, asset, or expiry from the user.
- Never add a protocol token, governance, cross-chain support, or yield features to the MVP.
- Never weaken an invariant to simplify the frontend.

---

## 3. Required Working Method

For every meaningful task:

1. Read the relevant sections of `PLAN.md`.
2. Inspect existing code before proposing changes.
3. Write a short implementation plan in the current task context.
4. Identify affected invariants and failure modes.
5. Implement the smallest complete vertical slice.
6. Add or update tests in the same change.
7. Run formatting, linting, type checking, and relevant tests.
8. Report exactly what changed and what remains unverified.

Do not produce large speculative refactors. Prefer small, reviewable changes.

---

## 4. Repository Structure

Respect this intended structure:

```text
apps/web
apps/api
apps/relayer
contracts/mandate-registry
packages/contract-client
packages/sdk
packages/shared
packages/ui
packages/stellar
packages/config
prisma
scripts
docs
```

Do not create duplicate utility packages or place shared code inside application folders when it belongs in `packages/`.

---

## 5. Technology Constraints

### TypeScript

- Use strict TypeScript.
- Do not use `any` unless a third-party boundary makes it unavoidable.
- Prefer `unknown` plus validation.
- Use Zod at every untrusted input boundary.
- Use discriminated unions for state machines and error types.
- Store token quantities as integer strings or bigint-compatible values.
- Never use JavaScript floating-point numbers for token amounts.

### Rust and Soroban

- Use checked arithmetic.
- Keep contract methods small and auditable.
- Prefer explicit validation over clever abstractions.
- Do not use panics for normal business-rule failures where typed contract errors are possible.
- Require address authorization explicitly.
- Emit structured events for all successful state transitions.
- Keep on-chain metadata fixed-size and hash-based.

### Database

- Use PostgreSQL and Prisma.
- Use database transactions for idempotency and charge-state transitions.
- Add unique constraints for merchant idempotency keys, charge IDs, payment IDs, refund IDs, and webhook event IDs.
- Do not treat database rows as proof that an on-chain payment succeeded.

### Jobs

- Use deterministic job IDs.
- Ensure workers are safe under duplicate delivery.
- Separate permanent policy failures from transient infrastructure failures.
- Do not retry revoked, expired, duplicate, or over-limit charges.

---

## 6. Smart Contract Requirements

The `mandate-registry` contract must support:

```text
create_mandate
pause_mandate
resume_mandate
revoke_mandate
charge
refund
get_mandate
get_payment
```

### Required mandate states

```text
Active
Paused
Revoked
Completed
Expired
```

### Required amount rules

```text
Fixed amount
Variable amount with maximum per charge
```

### Required constraints

- Maximum per charge.
- Maximum per billing period.
- Minimum interval between charges.
- Start time.
- Expiry time.
- Maximum successful charge count.
- Duplicate charge prevention.
- Merchant authorization.
- Bounded asset allowance.

### Validation order

Before moving funds, validate:

1. Mandate existence.
2. Active status.
3. Start time.
4. Expiry.
5. Merchant authorization.
6. Unique charge ID.
7. Positive amount.
8. Amount rule.
9. Minimum interval.
10. Maximum successful charge count.
11. Billing-period rollover.
12. Remaining period allowance.
13. Token allowance.
14. Token balance.

Only then execute the token transfer and update accounting.

### Contract accounting rule

A failed token transfer must leave:

- `successful_charges`
- `total_collected`
- `current_period_collected`
- `last_charged_at`
- payment receipt storage

unchanged.

---

## 7. Mandatory Security Invariants

Every contract change must preserve and test these invariants.

### Authorization

- Only the payer may create, pause, resume, or revoke a mandate.
- Only the merchant or an explicitly authorized delegate may charge it.
- The relayer has no special spending authority.

### Amounts

- Fixed mandates charge exactly the configured amount.
- Variable mandates never exceed `max_per_charge`.
- Period totals never exceed `max_per_period`.
- Refund totals never exceed the original payment.

### Time

- No charge before `start_at`.
- No charge at or after expiry.
- No charge before `min_interval_seconds` has elapsed.
- Period accounting resets only when the calculated period changes.

### Replay resistance

- A `charge_id` can succeed once at most.
- A `refund_id` can succeed once at most.
- API idempotency keys cannot be reused with different payloads.

### State

- Paused, revoked, completed, and expired mandates cannot be charged.
- Revocation is immediate and does not require merchant approval.
- Historical receipts are never deleted by revocation.

### Tokens

- Merchant receives exactly the charged amount.
- Payer loses exactly the charged amount.
- The mandate contract must not retain payment funds.
- Accounting changes and token movement are atomic.

---

## 8. Error Design

Create explicit, stable error codes.

Suggested contract errors:

```text
MandateNotFound
MandateNotActive
MandatePaused
MandateRevoked
MandateCompleted
MandateExpired
ChargeBeforeStart
ChargeTooSoon
InvalidAmount
AmountExceedsChargeLimit
AmountExceedsPeriodLimit
ChargeCountExceeded
DuplicateCharge
UnauthorizedMerchant
InsufficientAllowance
InsufficientBalance
PaymentNotFound
RefundExceedsPayment
DuplicateRefund
ArithmeticOverflow
```

Backend errors should map contract errors without losing the original code.

Do not return generic `INTERNAL_ERROR` for deterministic mandate failures.

---

## 9. Money and Time Handling

### Money

- Represent on-chain amounts as integer base units.
- Represent API amounts as decimal strings.
- Convert using the asset’s declared decimals.
- Reject values with more precision than the asset supports.
- Never use floating-point arithmetic.
- Never silently round a user-entered amount.

### Time

- Use UTC everywhere.
- Store timestamps as Unix seconds on-chain and ISO 8601 in APIs.
- Use fixed-duration billing periods in the MVP.
- Do not implement calendar-month logic inside the contract.
- Test period boundaries explicitly.

---

## 10. API Rules

### Authentication

- Merchant API keys must be hashed at rest.
- Show a new API key only once.
- Support key rotation.
- Rate-limit sensitive endpoints.

### Idempotency

Require an `Idempotency-Key` for:

```text
POST /v1/checkout-sessions
POST /v1/mandates/:id/charges
POST /v1/payments/:id/refunds
```

Store:

- Merchant ID.
- Key.
- Request hash.
- Response status.
- Response body.

If the same key is reused with a different request hash, reject it.

### Validation

Every public API input must pass a Zod schema.

Do not accept:

- Negative or zero charge amounts.
- Unknown assets.
- Unbounded durations.
- Arbitrary webhook protocols.
- Unvalidated wallet addresses.

---

## 11. Relayer Rules

The relayer must:

1. Load fresh contract state.
2. Build a deterministic invocation.
3. Simulate before submission.
4. Confirm merchant, amount, asset, and charge ID.
5. Submit once per deterministic job ID.
6. Persist the transaction hash.
7. Wait for final transaction status.
8. Reconcile on-chain events.

### Retry only transient failures

Retry examples:

- RPC unavailable.
- Temporary timeout.
- Transaction not included.
- Insufficient balance, when merchant retry policy permits.
- Insufficient allowance, when merchant retry policy permits.

Never retry automatically:

- Revoked mandate.
- Expired mandate.
- Duplicate charge.
- Over-limit amount.
- Charge too soon.
- Maximum charge count reached.

Two workers may receive the same job. The system must still produce at most one successful charge.

---

## 12. Webhook Rules

- Sign all webhooks with HMAC SHA-256.
- Include timestamp, event ID, and signature version.
- Retry failed deliveries with exponential backoff.
- Preserve the same event ID across retries.
- Provide a verification helper in the SDK.
- Never include API keys, private keys, or internal stack traces.

Required events:

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

---

## 13. Frontend Rules

### Consumer UI

Use familiar language:

- “Automatic payment.”
- “Maximum charge.”
- “Billing frequency.”
- “Cancel autopay.”

The mandate review screen must show:

- Merchant.
- Payment asset.
- Fixed amount or maximum amount.
- Maximum per period.
- Minimum interval.
- Start date.
- Expiry date.
- Maximum number of charges.
- Maximum theoretical total, when calculable.

Never hide critical terms inside an expandable section.

### Merchant UI

Prioritize:

- Product creation.
- Checkout links.
- Active mandates.
- Upcoming payments.
- Failed payments.
- Webhook status.

Do not expose blockchain-specific complexity unless needed for debugging.

### Styling

- Use shadcn/ui primitives.
- Keep layouts simple and financial-product-like.
- Avoid excessive gradients, glow effects, and crypto visual clichés.
- Ensure keyboard navigation and visible focus states.
- Meet WCAG AA contrast.

---

## 14. Testing Requirements

No feature is complete without tests.

### Contract tests

Every contract method needs:

- Success case.
- Authorization failure.
- Boundary values.
- Invalid state.
- Replay attempt.

### Required contract scenarios

- Fixed charge success.
- Variable charge success.
- Over-limit rejection.
- Period-cap rejection.
- Too-early rejection.
- Expired rejection.
- Paused rejection.
- Revoked rejection.
- Duplicate charge rejection.
- Maximum charge count.
- Period rollover.
- Insufficient allowance.
- Insufficient balance.
- Full refund.
- Partial refund.
- Over-refund rejection.
- Duplicate refund rejection.
- Transfer failure rollback.

### Backend tests

- API-key authentication.
- Input validation.
- Idempotency.
- Charge-state transitions.
- Duplicate job handling.
- Webhook signatures.
- Webhook retries.

### End-to-end test

Maintain one test that covers:

```text
merchant product
→ checkout session
→ wallet authorization
→ mandate creation
→ token approval
→ charge request
→ relayer execution
→ webhook
→ consumer payment history
→ mandate revocation
→ rejected later charge
```

---

## 15. Commands to Run Before Marking Work Complete

Use the repository’s actual scripts once created. The intended command set is:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For contract changes, also run the local Soroban integration suite.

Do not claim a command passed unless it was executed successfully.

---

## 16. Environment and Secret Handling

- Commit `.env.example`, never `.env`.
- Never log secrets.
- Never place private keys in source files.
- Separate testnet and local-development keys.
- Use least-privilege merchant and relayer credentials.
- Validate required environment variables at startup.
- Fail fast when required configuration is missing.

Expected variables may include:

```text
DATABASE_URL
REDIS_URL
STELLAR_NETWORK
SOROBAN_RPC_URL
HORIZON_URL
MANDATE_CONTRACT_ID
RELAYER_SECRET_KEY
WEBHOOK_ENCRYPTION_KEY
API_KEY_HASH_SECRET
```

The exact list should live in a typed environment module.

---

## 17. Database and State-Machine Rules

Use explicit states.

### Charge request state machine

```text
scheduled
→ processing
→ simulated
→ submitted
→ succeeded
```

Failure branches:

```text
processing → retryable_failed
processing → permanently_failed
submitted → retryable_failed
submitted → permanently_failed
```

A succeeded charge is terminal.

### Webhook delivery state machine

```text
pending
→ delivering
→ delivered
```

or:

```text
pending
→ delivering
→ retry_scheduled
→ dead_letter
```

Use database constraints to prevent impossible transitions where practical.

---

## 18. Implementation Sequence

Build in this order unless a task explicitly requires otherwise:

1. Repository foundation.
2. Contract state types and errors.
3. Create, pause, resume, and revoke.
4. Fixed charge execution.
5. Variable capped charge execution.
6. Billing-period accounting.
7. Refunds.
8. Contract tests and invariant tests.
9. Testnet deployment and generated client.
10. Merchant API.
11. Relayer.
12. Consumer checkout.
13. Consumer mandate dashboard.
14. Merchant dashboard.
15. Webhooks and SDK.
16. End-to-end test.
17. Security hardening.
18. Demo polish.

Do not begin path payments, passkeys, x402, MPP, or anchor integrations before the fixed and variable mandate flows are complete.

---

## 19. Scope Control

Reject or defer changes that introduce:

- Governance.
- Tokens.
- Yield farming.
- Lending.
- Cross-chain messaging.
- NFT subscriptions.
- Arbitrary plugin execution.
- AI-generated billing decisions.
- Decentralized arbitration.
- Mainnet deployment before audit readiness.

Record deferred ideas in `docs/roadmap.md` rather than partially implementing them.

---

## 20. Code Quality Standards

- Prefer clear names over short names.
- Keep functions focused.
- Avoid hidden side effects.
- Avoid duplicated business rules across frontend, backend, and contract.
- Contract rules are canonical; frontend and backend mirrors should use shared types and tests.
- Add comments for invariants and non-obvious protocol reasoning, not obvious syntax.
- Remove dead code.
- Do not leave placeholder `TODO` comments without an issue or explanation.
- Do not commit generated secrets, local database files, or build artifacts.

---

## 21. Documentation Requirements

When behavior changes, update the relevant documentation:

- `PLAN.md` for product or architectural scope.
- `docs/contract-invariants.md` for contract rule changes.
- `docs/merchant-api.md` for endpoint changes.
- `docs/threat-model.md` for new trust assumptions or attack surfaces.
- `docs/demo-script.md` for demo-visible changes.

Every public API and SDK method should include a minimal working example.

---

## 22. Definition of a Complete Pull Request

A change is complete only when:

- The implementation matches `PLAN.md`.
- Relevant tests were added or updated.
- Lint, typecheck, build, and tests pass.
- Contract invariants remain true.
- Errors are explicit and actionable.
- Documentation is updated.
- No secrets or unsafe unlimited approvals were introduced.
- The final summary lists commands executed and any remaining risks.

---

## 23. Agent Stop Conditions

Stop and report rather than guessing when:

- A contract change would weaken a security invariant.
- Token-interface behavior is unclear.
- A Soroban authorization assumption is unverified.
- A migration could corrupt existing mandate state.
- A requested feature conflicts with immediate revocation or bounded spending.
- Testnet behavior differs from local behavior and the cause is unknown.

When blocked, provide:

1. The exact failing assumption.
2. Evidence from code or test output.
3. The smallest safe next step.

Do not silently work around protocol uncertainty.

---

## 24. Final Product Standard

The project should make the following statement demonstrably true:

> A merchant may request recurring stablecoin payments, but only the user-defined Soroban mandate can authorize the amount, timing, asset, frequency, and lifetime of those payments.

Everything else is secondary.

