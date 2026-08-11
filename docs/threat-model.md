# Threat Model

This document will enumerate the trust assumptions and attack surfaces of Stellar Mandates —
a malicious or compromised relayer, a malicious merchant, a malicious token contract, replay
and idempotency-key abuse, concurrent-worker races, and stale-simulation submission — each
mapped to a mitigation and the adversarial test that proves it (PLAN.md §19-20).

Status: stub, filled in Phase 14 (security hardening).

## Phase 8 additions (tracked here now, full analysis + adversarial tests in Phase 14)

New attack surfaces introduced by the merchant API, recorded so Phase 14 doesn't have to
rediscover them:

- **Compromised/leaked merchant API key.** Mitigated by hashing at rest (HMAC-SHA256 with
  `API_KEY_HASH_SECRET` as pepper, never a bare hash), constant-time verification, and
  self-service rotation (`POST /v1/merchants/me/api-keys/rotate`) that revokes the old key
  atomically. Not yet covered: key-scoped permissions, anomaly detection, or forced rotation on
  suspected leak.
- **Idempotency-key abuse.** Reusing a key with a different body is rejected (409); concurrent
  identical requests are serialized by a real Postgres transaction (see
  `apps/api/src/idempotency/middleware.ts`), not by application-level locking that could be
  bypassed by a second process. Not yet load-tested under adversarial concurrency (Phase 14).
- **Unauthenticated `POST /v1/merchants`.** Necessarily open (bootstrap problem), rate-limited
  5/min/IP. A determined attacker could still script many merchant accounts over time; no
  additional verification (e.g. email confirmation, CAPTCHA) exists yet.
- **Webhook URL as an SSRF vector.** `POST /v1/webhook-endpoints/test` only validates
  `http(s)://` scheme today and never performs a live outbound request (it just queues a
  `WebhookDelivery` row) — real delivery (Phase 12) must add SSRF hardening (reject
  private/loopback/link-local targets, no redirect-following to those) before it ever makes a
  real network call.
- **Mandate ownership leak via enumeration.** `GET /v1/mandates/:id` and the charge-creation path
  return the same `MandateNotFound` for "doesn't exist" and "exists but belongs to a different
  merchant" — deliberately, to avoid confirming a mandate id's existence to a non-owner.

## Phase 9 additions — relayer

### Threat: relayer manipulation (alters amount or destination)

**Mitigation, two independent layers:**

1. **On-chain, structural.** `charge(mandate_id, charge_id, amount, invoice_hash)` takes no
   merchant/destination parameter at all — the payout address is read only from the stored
   `Mandate` (`contracts/mandate-registry/src/charge.rs`). There is no argument for a relayer to
   tamper with that would redirect funds. `amount` is bound by `mandate.merchant.require_auth()`'s
   Soroban authorization entry, which hashes the exact function name + arguments the merchant
   signed — changing `amount` after the merchant signs invalidates that signature, causing the
   *token-level* authorization to fail, not a policy check the relayer could route around. Proven
   by the Phase 3/4/6 contract test suites (`AmountExceedsChargeLimit`/`AmountExceedsPeriodLimit`
   rejections, the `Variable`-rule per-charge-cap tests, and the property/adversarial suites) —
   Phase 9 does not re-derive this proof, it depends on it.
2. **Application-level, defense-in-depth.** `apps/relayer/src/pipeline.ts`'s verification step
   (decision #3) compares the *simulated* charge receipt's `merchant`/`asset`/`amount`/`chargeId`/
   `mandateId`/`invoiceHash` against the `ChargeRequest` row and its owning `Merchant`/`Product` —
   read fresh from the DB and from on-chain state, never from anything the relayer process itself
   could have fabricated in memory. A mismatch is a hard failure (`SIMULATION_MISMATCH`), never a
   retry, and — critically — `submit()` is never called in that case, so no signature is even
   requested for a mismatched charge.

**Proving tests** (`apps/relayer/src/pipeline.test.ts`, "relayer cannot alter amount or
destination" suite, real Postgres, `FakeChainGateway`): a simulated receipt with a different
merchant, an inflated amount, or a different asset than the `ChargeRequest`/`Product` describe is
each rejected before `gateway.submit()` is ever invoked (`submitCallLog` stays empty in every
case) — i.e. the point in the pipeline that would carry the merchant's signature to the network is
structurally unreachable for a request that disagrees with fresh chain state.

### Threat: duplicate job delivery / two workers processing the same charge

**Mitigation:** a DB-guarded `scheduled|retryable_failed -> processing` transition
(`apps/api/src/state-machine.ts::transitionChargeRequest`, a guarded `updateMany` scoped to the
expected current status) is the actual at-most-one-success guarantee — not BullMQ's own job
locking, which the system deliberately does not rely on alone (a second worker that somehow also
picks up the same job still loses the DB race and touches the chain zero times).

**Proving test:** `apps/relayer/src/pipeline.test.ts`'s "duplicate job delivery" suite — two
independent Prisma connections race `processChargeRequest` on the same `ChargeRequest` id against
a real Postgres; asserts exactly one `succeeded` outcome, exactly one `Payment` row, and exactly
one call into the chain gateway's `submit()`.

### Threat: stale simulation (chain state changes between simulate and submit)

**Mitigation:** the real submission (`AssembledTransaction.signAndSend()`) re-executes the
contract for real on the ledger — it does not replay the earlier simulation's verdict. If the
mandate was revoked/paused/expired/exhausted in the interval, the contract's own validation order
(CLAUDE.md §6) rejects the *real* execution with a typed `Result::Err`, which the pipeline
classifies exactly like any other contract rejection (`fail("submitted", ...)`, no `Payment` row).

**Proving test:** `apps/relayer/src/pipeline.test.ts`'s "stale simulation" case — a simulation that
looked fine but whose `submit()` step returns a real (fake-gateway-simulated) `contract_error` for
`MandateRevoked`, with a genuine tx hash recorded on the `ChargeRequest` for audit even though no
`Payment` row is ever created.

### Threat: unmapped/unknown contract error silently defaults to "retry forever"

**Mitigation:** `apps/relayer/src/classify.ts`'s `classifyContractErrorName` throws
`UnclassifiableContractError` for any name outside the frozen 24-code table instead of returning a
default classification.

**Proving test:** `apps/relayer/src/classify.test.ts` — one assertion per one of the 24 frozen
codes (asserting the exact expected class) plus an explicit "unmapped code throws" case.

### Open trust-model question: merchant charge authorization

`contracts/mandate-registry/src/charge.rs` requires `mandate.merchant.require_auth()` on *every*
`charge` call. No mechanism was defined in Phases 1-8 for a merchant's signature over a specific,
server-generated `charge_id` to reach the relayer process without that process custodying a
merchant secret key — which would itself be a spending-authority leak this whole phase exists to
prevent. This is **not silently resolved**: `apps/relayer/src/chain-gateway.ts`'s
`resolveMerchantSigner` is an injected seam, and the production entrypoint
(`apps/relayer/src/index.ts`) throws a clear, actionable error rather than pretending to work. The
required real-testnet proof run (`scripts/run-relayer-testnet-demo.ts`) supplies the same known
demo merchant keypair Phase 7 already used — acceptable for a demo proof, explicitly not a
production design. The most likely real mechanism (not yet built): the merchant's own backend
pre-signs the specific Soroban authorization entry at charge-request time and the API persists the
signed XDR for the relayer to attach — never a raw key reaching this process.
