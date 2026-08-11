# Threat Model

Phase 14 security review. The Soroban contract is the policy authority. API, relayer, RPC,
database, and UI state are untrusted hints until the contract validates the real transaction.

## Trust boundaries

- Payer and merchant signatures authorize only their exact Soroban invocation trees.
- The relayer pays fees and transports authorization. It must have no payer spending authority.
- The configured RPC is trusted for availability and reads. Final contract execution remains
  authoritative for money movement.
- Postgres and Redis coordinate work; neither can relax contract rules.
- Webhook receivers and merchant-supplied URLs are hostile network peers.

## PLAN §19 threats: mitigation and proof

### 1. Unlimited token approval

**Mitigation.** Checkout computes maximum theoretical exposure, adds only disclosed fee headroom,
and approves that bounded amount until mandate expiry. Changing a non-zero allowance uses
zero-then-set. Cancellation offers an immediate allowance reset to zero.

**Proof.**

- `apps/web/src/lib/mandate-terms.test.ts`: exposure/headroom and zero-exposure bounds.
- `apps/web/src/components/checkout/checkout-flow.test.tsx`: zero-then-set ordering.
- `apps/web/e2e/checkout.spec.ts`: visible exposure and bounded approval.
- `apps/web/e2e/dashboard.spec.ts`: revoke then allowance-to-zero flow.

### 2. Merchant replay attack

**Mitigation.** `charge_id` is permanently consumed on-chain only by a successful charge.
Merchant API idempotency is merchant-scoped, request-body-bound, and transactionally serialized.
Duplicate worker claims use guarded database transitions.

**Proof.**

- `contracts/mandate-registry/src/test_adversarial.rs::charge_id_reuse_after_success_is_rejected_and_does_not_double_spend`.
- `contracts/mandate-registry/src/test_charge.rs::charge_duplicate_charge_id_after_success_rejected`.
- `apps/api/src/idempotency/middleware.test.ts`: replay, conflict, and concurrent duplicate cases.
- `apps/relayer/src/pipeline.test.ts`: two workers produce one submission and one payment.

### 3. Relayer manipulation

**Mitigation.** Destination is read from the stored mandate; `charge` has no destination
parameter. Amount and all invocation arguments are covered by merchant authorization and contract
limits. Before signing/submission, the relayer compares simulated merchant, asset, amount,
mandate ID, charge ID, and invoice hash with fresh chain and database context.

**Proof.**

- `apps/relayer/src/pipeline.test.ts`, “relayer cannot alter amount or destination”: wrong
  merchant, altered amount, and wrong asset never call `submit()`.
- `contracts/mandate-registry/src/test_property.rs`: randomized policy/accounting invariants.

### 4. Double charge around period boundary

**Mitigation.** The contract derives the period index from ledger time and the original
`start_at`. Validation, token movement, period rollover, and accounting execute atomically.

**Proof.**

- `contracts/mandate-registry/src/test_adversarial.rs::period_boundary_is_exact_not_off_by_one`.
- `contracts/mandate-registry/src/test_period.rs::period_boundary_second_before_still_old_period_exact_boundary_is_new_period`.

### 5. Merchant charges immediately after revocation

**Mitigation.** Revocation and charge are atomic contract calls. Ledger order decides the race.
Any charge executed after revocation reads `Revoked` and fails; stale simulation cannot override
final execution.

**Proof.**

- `contracts/mandate-registry/src/test_adversarial.rs::revoke_immediately_blocks_any_later_charge_attempt`.
- `apps/relayer/src/pipeline.test.ts`, “stale simulation”: simulated success followed by final
  `MandateRevoked` writes no payment.

### 6. Front-running

**Mitigation.** A copied transaction cannot change merchant, amount, asset, mandate, or charge ID
without invalidating authorization. An unchanged copy loses the unique charge-ID race. Relayer
verification rejects any simulated divergence before submission.

**Proof.**

- Replay and relayer-manipulation proofs in threats 2 and 3.
- Contract authorization assertions in `contracts/mandate-registry/src/test_auth.rs`.

### 7. Malicious invoice metadata

**Mitigation.** Plaintext metadata never enters the contract. `metadata_hash` and `invoice_hash`
are fixed 32-byte values. API schemas accept only 64-character hexadecimal hashes. Current UI
does not render merchant-supplied invoice HTML.

**Proof.**

- `contracts/mandate-registry/src/events.rs`: hash-only event payloads.
- `apps/api/src/schemas/charges.ts` and `packages/shared/src/types.test.ts`: fixed hash schema.
- `apps/api/src/routes/charges.test.ts`: malformed input rejected at the boundary.

### 8. Compromised merchant API key

**Mitigation.** Raw keys are shown once and never stored. HMAC-SHA256 uses a server-side pepper;
verification is constant-time; rotation atomically revokes the old key. Sensitive routes are
rate-limited. A stolen key can request charges but cannot exceed on-chain amount, timing, asset,
count, expiry, or revocation policy.

**Proof.**

- `apps/api/src/auth/api-key.test.ts`: storage, wrong pepper, rotation, disable, authentication.
- `apps/api/src/security-hardening.test.ts`: rapid bursts hit limits on merchant creation,
  key rotation, charge creation, and public checkout mutation/read routes.
- `contracts/mandate-registry/src/test_property.rs`: the API cannot weaken contract caps.

### 9. Webhook spoofing

**Mitigation.** HMAC-SHA256 covers timestamp, stable event ID, and exact raw body. Verification
rejects tampering, wrong secrets, stale/future timestamps, and malformed headers. Receiver errors
retry on a finite schedule and then dead-letter. Outbound URLs reject private, loopback,
link-local, unsafe DNS, and redirects.

**Proof.**

- `packages/shared/src/webhook-signature.test.ts` and
  `packages/sdk/src/verify-webhook.test.ts`: signature/timestamp validation.
- `packages/shared/src/webhook-url-guard.test.ts`: SSRF address/DNS cases.
- `apps/relayer/src/webhook-delivery.test.ts`: duplicate delivery, stable ID, secret-free body,
  repeated 503 errors through all six attempts, and terminal dead-letter.

## PLAN §20.5 adversarial coverage

| Attack                               | Proving test                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Relayer changes amount               | `apps/relayer/src/pipeline.test.ts` altered-amount mismatch                                |
| Merchant changes asset               | `apps/relayer/src/pipeline.test.ts` wrong-asset mismatch                                   |
| Merchant reuses charge ID            | `test_adversarial.rs::charge_id_reuse_after_success_is_rejected_and_does_not_double_spend` |
| Two workers submit one charge        | `apps/relayer/src/pipeline.test.ts` duplicate-job race                                     |
| Charge and revocation close together | `test_adversarial.rs::revoke_immediately_blocks_any_later_charge_attempt`                  |
| Period-boundary race                 | `test_adversarial.rs::period_boundary_is_exact_not_off_by_one`                             |
| Stale RPC simulation                 | `apps/relayer/src/pipeline.test.ts` stale-simulation case                                  |
| Repeated webhook errors              | `apps/relayer/src/webhook-delivery.test.ts` six-attempt 503 exhaustion                     |

## Operational controls

- `pnpm security:audit` scans source/untracked files for Stellar seeds, PEM private keys, and
  likely secret logging. It rejects tracked runtime environment files and secret-bearing
  deployment registries, and verifies `.env` remains ignored. Testnet/local keys therefore stay
  in separate runtime environment or Stellar CLI identity stores, never a source fallback.
- Relayer output uses `createSafeJsonLogger`, recursively redacts secret fields/values, and emits
  `requestId`, `merchantId`, `mandateId`, `chargeId`, and `transactionHash` where applicable.
- API Pino redaction covers authorization, API keys, webhook secrets/encryption keys, cookies,
  and private keys. Completion logs emit the same applicable correlation fields.
- `ObservabilityRegistry` implements all PLAN §21 signals. The relayer emits a redacted
  `observability.snapshot` every minute.

## Known residual risks

- **Authorization availability.** Merchant charge authorization is now an exact,
  invocation-bound Soroban auth entry. The API verifies signer, network, contract, method,
  mandate, charge, amount, invoice hash, and expiry; encrypts the signed XDR at rest; and the
  relayer attaches it without merchant-key custody. Loss or rotation of the encryption key makes
  pending authorizations unusable and must be handled as an operational secret-rotation event.
- **RPC trust/retention.** A faulty RPC can delay reads, simulation, or webhooks. It cannot make
  the contract accept an invalid final transaction. The indexer fails loudly on retention gaps.
- **Monitoring delivery.** Prometheus samples and Alertmanager state persist on Render disks.
  Alerts are visible in Alertmanager/Grafana, but email delivery is intentionally unconfigured.
- **Merchant identity versus business identity.** Wallet ownership is proven with an exact,
  expiring, one-time signed challenge before profile creation. This proves control of the payout
  wallet, not the merchant's legal business identity; add KYB only when the product requires it.
