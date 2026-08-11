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

## Phase 10 additions — consumer checkout (two new unauthenticated routes)

Phase 10 needed `apps/api` to answer the browser directly (no merchant API key), which is a new
kind of attack surface for this API: everything before Phase 10 assumed a caller either had a
bearer token or was the unauthenticated-by-necessity merchant bootstrap. Recorded here now, full
adversarial coverage in Phase 14.

- **`GET /v1/checkout-sessions/:id/public` as an enumeration/information-disclosure vector.**
  Unlike `GET /v1/mandates/:id` (deliberately returns the same 404 for "doesn't exist" vs. "exists,
  wrong owner"), this route has no owner check at all by design — anyone with a session id can
  read it, matching a checkout link's own trust model (a session id is the bearer credential; it's
  handed to the exact person meant to complete the checkout, same as any payment-link URL). The
  response is scoped to display-safe fields only (no webhook URL/secret/API keys) specifically so
  this openness can't leak anything the merchant wouldn't already be showing the payer anyway.
  Session ids (`cuid`-style Prisma default) are not sequential/guessable, so this isn't a practical
  enumeration vector, but no explicit rate limit is scoped to this route beyond the app's global
  IP-keyed default (1000/min) — Phase 14 should consider a tighter one.
- **`POST /v1/checkout-sessions/:id/mandate` accepting an attacker-supplied `mandateId`.**
  Mitigated the same way `checkout-sessions.ts`'s handler documents inline: the mandate is
  independently re-read from chain and its `merchant`/`asset`/`payer` are checked against the
  session's own product/merchant and the caller's claimed `payerAddress` before anything is
  persisted. Worst case for a forged call: a session gets associated with a real, unrelated
  on-chain mandate that happens to match all three checks (which requires the attacker to already
  know a real mandate's payer address and have it match a merchant/asset the attacker also
  controls a session for) — never a fabricated mandate, never a fund movement. `session.mandateId`
  is one-way-settable (`CHECKOUT_SESSION_ALREADY_LINKED` on any attempt to overwrite with a
  *different* mandate id), so this can't be used to repeatedly re-point a session either.
- **Permissive CORS (`origin: true`) applied globally, not scoped to just these two routes.**
  Deliberate, not an oversight (see `docs/architecture.md`'s Phase 10 section) — every other route
  still requires the bearer token regardless of origin, so CORS here only affects which websites'
  JavaScript *can attempt* a request, not whether that request is authorized. Phase 14 should still
  double check no authenticated route relies on cookie-based session state that CORS + credentials
  could expose (currently none do — auth is a bearer header the browser never sends automatically
  cross-origin).

## Phase 12c additions — on-chain event indexer

A new trust boundary: `apps/relayer/src/indexer` is the first component in this system that
*observes* chain state through a channel other than a direct request/response `get_mandate`/
`charge` simulation — it polls Soroban RPC's `getEvents` and reacts to whatever it returns.

- **Trusting the RPC node's event stream.** The indexer has no independent way to verify that a
  Soroban RPC node is returning a complete, un-tampered event stream for the mandate-registry
  contract — the same trust already implicitly extended to every other RPC-dependent read in this
  system (`get_mandate`, transaction simulation/submission). A malicious or buggy RPC node could in
  principle omit or fabricate events. Mitigation is the same as everywhere else in this codebase:
  the contract itself remains the actual policy authority (CLAUDE.md §2) — the indexer only ever
  produces a *notification* (`MandateIndex` refresh, merchant webhook), never a fund-moving action
  or a bypass of the charge/refund validation path. A dropped or fabricated event at worst causes a
  stale dashboard/missed webhook, never an incorrect charge.
- **Deterministic-event-id collision across producers.** `WebhookDelivery.eventId` is a single
  table-wide unique constraint shared by every producer (`randomUUID()` from the charge pipeline,
  `chain:<rpc event id>` from the indexer, `webhook.test` sentinel strings from the test endpoint).
  A collision between a random UUID and a `chain:`-prefixed deterministic id is astronomically
  unlikely and would only ever cause one delivery to be silently dropped (an availability concern,
  never an authorization one) — not treated as a live threat, but recorded here since it's a shared
  namespace, not a per-producer one.
- **Merchant misattribution via `Merchant.walletAddress` reuse.** `mandate-index-sync.ts` resolves
  an event's owning merchant by matching the on-chain `merchant` address against
  `Merchant.walletAddress`, which has no uniqueness constraint in the schema. If two `Merchant` rows
  ever shared a wallet address (not possible through this system's own merchant-creation flow today,
  which doesn't check for it either), `findFirst` would pick one arbitrarily and the other would
  never be notified for that mandate. Low real-world likelihood given the current onboarding flow,
  but flagged here rather than silently assumed away — Phase 14 should consider a uniqueness
  constraint on `Merchant.walletAddress`.
- **Retention-gap failure mode is fail-loud, not fail-safe-by-default.** `IndexerRetentionGapError`
  stops the indexer from advancing past a gap, but does not automatically page anyone — an operator
  has to be watching the relayer's logs (`indexer.retention_gap` at `"error"` level) to notice. This
  is an operational-maturity gap (alerting), not a correctness one: the alternative (silently
  skipping the gap) is strictly worse and is what decision #1 explicitly rejected.
