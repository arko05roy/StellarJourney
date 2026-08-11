# Merchant API

Phase 8 (core endpoints), extended in Phase 12a (webhook registration + delivery, `@paymap/sdk`),
Phase 12b (dashboard lists), and Phase 16 (scoped keys and non-custodial charge authorization).
Base URL (local): `http://localhost:3001`. All endpoints are versioned under `/v1`.

The contract is the policy authority (CLAUDE.md §1). This API is a workflow layer around it: it
verifies on-chain mandate state before accepting a charge, schedules work for the relayer
(Phase 9) to execute, and never writes a `Payment` row from its own optimism — only from a
confirmed on-chain result.

## Scope note: endpoints beyond PLAN.md §14's literal list

PLAN.md §14 lists ten endpoints. Authentication, key-management, webhook, and dashboard-list
endpoints also exist:

```text
POST   /v1/merchant-auth/challenges        (single-use wallet ownership challenge)
POST   /v1/merchant-auth/complete          (verify signature + issue dashboard session)
POST   /v1/merchant-auth/register          (create profile for a verified wallet)
POST   /v1/merchant-auth/logout            (revoke dashboard session)
GET    /v1/merchants/me/api-keys           (list integration keys)
POST   /v1/merchants/me/api-keys           (create a scoped integration key)
DELETE /v1/merchants/me/api-keys/:id       (revoke an integration key)
POST   /v1/merchants/me/api-keys/rotate    (rotate: issue a new key, revoke the old one)
POST   /v1/webhook-endpoints               (Phase 12a: register/rotate the real delivery URL + secret)
GET    /v1/webhook-endpoints               (Phase 12a: status read, never the secret)
GET    /v1/products                        (Phase 12b: merchant's product catalog, for the dashboard)
GET    /v1/checkout-sessions               (Phase 12b: merchant's checkout-link history)
GET    /v1/mandates                        (Phase 12b: merchant's mandate list, live on-chain per row)
GET    /v1/charges                         (Phase 12b: merchant's charge-request list, filterable by status)
GET    /v1/refunds                         (Phase 12b: merchant's refund-request list)
GET    /v1/webhook-deliveries              (Phase 12b: merchant's webhook delivery history)
```

Human merchant authentication is deliberately separate from integration credentials: wallet
ownership creates a short-lived dashboard session, while API keys are optional, scoped, and
created afterward under Developers. The webhook-endpoints pair exists because real signed delivery
(CLAUDE.md §12) needs somewhere to register a URL and secret — `PLAN.md §14`'s
`POST /v1/webhook-endpoints/test` alone only ever validated a candidate URL, it never persisted
one. The six Phase 12b `GET .../` list endpoints exist because PLAN.md §14 only ever specifies
single-resource reads (`GET /v1/mandates/:id`, `GET /v1/charges/:id`) or a payments list scoped by
`mandateId` — none of that is enough to render PLAN.md §16.3's merchant dashboard views (Products,
Checkout links, Active mandates, Upcoming/Failed collections, Refunds, Webhooks), which need a
merchant-scoped _list_ of each resource. Each one mirrors an existing single-resource read's
auth/ownership rules exactly, just without the `:id`. Everything else matches PLAN.md §14 exactly.

## Authentication

The challenge and completion endpoints are public but rate-limited. Completion succeeds only for
the exact, unexpired, unused message signed by the requested Stellar account.

Dashboard requests use:

```text
Authorization: Bearer pms_live_<opaque session>
```

Sessions expire after 24 hours, are revocable, and are stored hashed at rest. They authorize a
human dashboard session only; they are not API keys.

Server integrations use `Authorization: Bearer sk_live_<random>`. API keys are **hashed at rest** with HMAC-SHA256, using
`API_KEY_HASH_SECRET` as the pepper (never a bare hash — the secret must matter, or a stolen
database dump alone would be dictionary-attackable). Verification is a constant-time comparison
of the full digest (`node:crypto`'s `timingSafeEqual`), not a substring/prefix check.

The **full API key is shown exactly once** — at creation, and again at legacy rotation. It is never stored
in recoverable form and never returned by any other endpoint.

### Scoped keys

Keys carry immutable scopes:

```text
products:read products:write checkout_sessions:read checkout_sessions:write
mandates:read charges:read charges:write payments:read refunds:read refunds:write
webhooks:read webhooks:write api_keys:manage
```

New merchants receive no API key automatically. A wallet session or a key with
`api_keys:manage` can list, create, and revoke merchant keys. Missing permission returns
`403 INSUFFICIENT_SCOPE` before resource lookup.
`POST /v1/merchants/me/api-keys`, `GET /v1/merchants/me/api-keys`, and
`DELETE /v1/merchants/me/api-keys/:id` manage keys; a key cannot revoke itself.

### Key rotation

```http
POST /v1/merchants/me/api-keys/rotate
Authorization: Bearer sk_live_OLD...
```

```json
{ "apiKeyId": "…", "apiKey": "sk_live_NEW...", "revokedApiKeyId": "…" }
```

The old key is revoked in the same database transaction the new key is issued in — there is never
a window with zero or two active keys. Any request using the old key after this point gets:

```json
{ "code": "API_KEY_REVOKED", "message": "This API key has been revoked. Rotate to a new key." }
```

### Auth error codes

| Code                       | HTTP | Meaning                                                       |
| -------------------------- | ---- | ------------------------------------------------------------- |
| `MISSING_API_KEY`          | 401  | No `Authorization` header, or not `Bearer <key>` shaped.      |
| `INVALID_API_KEY`          | 401  | Header present but no stored key hash matches.                |
| `API_KEY_REVOKED`          | 401  | The hash matches a key that has since been rotated out.       |
| `INVALID_MERCHANT_SESSION` | 401  | Dashboard session token is malformed or unknown.              |
| `MERCHANT_SESSION_EXPIRED` | 401  | Dashboard session expired or was revoked.                     |
| `INVALID_AUTH_CHALLENGE`   | 401  | Wallet challenge is missing or altered.                       |
| `AUTH_CHALLENGE_EXPIRED`   | 401  | Wallet challenge exceeded its five-minute lifetime.           |
| `INVALID_WALLET_SIGNATURE` | 401  | Signature does not verify for the connected account.          |
| `WALLET_ADDRESS_MISMATCH`  | 401  | A different wallet signed the challenge.                      |
| `MERCHANT_DISABLED`        | 403  | The key is valid but the merchant account itself is disabled. |
| `INSUFFICIENT_SCOPE`       | 403  | The key lacks a scope required by the route.                  |

## Idempotency

Required (`Idempotency-Key` header) on:

```text
POST /v1/checkout-sessions
POST /v1/mandates/:id/charge-authorizations
POST /v1/payments/:id/refunds
```

Missing header → `400 MISSING_IDEMPOTENCY_KEY`.

**Contract:** the same `(merchant, Idempotency-Key)` pair with the **same** request body replays
the original response verbatim (including the original HTTP status) — the side-effecting write
never runs twice. The same key with a **different** body is rejected:

```json
{
  "code": "IDEMPOTENCY_KEY_REUSED",
  "message": "This Idempotency-Key was already used with a different request body."
}
```

**Concurrency safety:** one Postgres transaction wraps the idempotency-record insert, the
side-effecting write, and the response write, together. A concurrent, identical request's insert
blocks on Postgres's own MVCC conflict resolution until the first transaction commits, then finds
the already-completed row and replays it — never a second execution, never a half-written record.
See `apps/api/src/idempotency/middleware.ts`'s module doc for the exact mechanism (including why a
naive `catch` around a failed insert does not work — it poisons the enclosing transaction).

A request rejected by validation or the on-chain precheck _before_ idempotency is invoked (e.g. a
revoked mandate) is not cached — a retry re-validates from scratch, which is strictly more correct
than replaying a stale verdict.

## Error format

Every error is:

```json
{ "code": "STABLE_CODE", "message": "human-readable", "details": ["optional, e.g. Zod issues"] }
```

`code` is always a stable, machine-readable string. Contract-originated failures use the
contract's own error name verbatim (CLAUDE.md §8) — never a generic `INTERNAL_ERROR`.

### Contract error → HTTP status

| Contract code              | HTTP | Retryable (relayer)   |
| -------------------------- | ---- | --------------------- |
| `MandateNotFound`          | 404  | no                    |
| `MandateNotActive`         | 409  | no                    |
| `MandatePaused`            | 409  | no                    |
| `MandateRevoked`           | 409  | no                    |
| `MandateCompleted`         | 409  | no                    |
| `MandateExpired`           | 409  | no                    |
| `ChargeBeforeStart`        | 409  | no                    |
| `ChargeTooSoon`            | 409  | no                    |
| `InvalidAmount`            | 422  | no                    |
| `AmountExceedsChargeLimit` | 422  | no                    |
| `AmountExceedsPeriodLimit` | 422  | no                    |
| `ChargeCountExceeded`      | 409  | no                    |
| `DuplicateCharge`          | 409  | no                    |
| `UnauthorizedMerchant`     | 403  | no                    |
| `InsufficientAllowance`    | 402  | yes (merchant policy) |
| `InsufficientBalance`      | 402  | yes (merchant policy) |
| `PaymentNotFound`          | 404  | no                    |
| `RefundExceedsPayment`     | 422  | no                    |
| `DuplicateRefund`          | 409  | no                    |
| `ArithmeticOverflow`       | 500  | no                    |
| `InvalidMandateInput`      | 400  | no                    |
| `DuplicateMandate`         | 409  | no                    |
| `InvalidStateTransition`   | 409  | no                    |
| `RefundNotFound`           | 404  | no                    |

### Other stable codes

| Code                                                                          | HTTP | Where                                                                                  |
| ----------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                                                            | 400  | any endpoint — Zod rejection, `details` lists each issue                               |
| `MISSING_IDEMPOTENCY_KEY`                                                     | 400  | the three idempotent POSTs                                                             |
| `IDEMPOTENCY_KEY_REUSED`                                                      | 409  | same key, different body                                                               |
| `INVALID_AMOUNT`                                                              | 400  | decimal→base-unit conversion failure (zero, over-precision, malformed)                 |
| `MANDATE_NOT_LINKED_TO_PRODUCT`                                               | 404  | charge/refund on a mandate with no checkout-session/product to resolve `decimals` from |
| `RATE_LIMITED`                                                                | 429  | rate-limited endpoints                                                                 |
| `PRODUCT_NOT_FOUND`, `CHECKOUT_SESSION_NOT_FOUND`, `CHARGE_REQUEST_NOT_FOUND` | 404  | resource not found or not owned by this merchant                                       |
| `INTERNAL_ERROR`                                                              | 500  | genuinely unexpected failure only                                                      |
| `MERCHANT_AUTHORIZATION_REQUIRED`                                             | 409  | legacy direct charge creation is disabled                                              |
| `INVALID_CHARGE_AUTHORIZATION`                                                | 400  | signed auth entry fails exact invocation/signature checks                              |
| `SCHEDULE_EXCEEDS_AUTHORIZATION_TTL`                                          | 400  | requested schedule exceeds bounded auth-entry lifetime                                 |

`MandateNotFound` is also returned (never a distinct "forbidden" code) when a mandate exists but
belongs to a different merchant — this API never reveals a mandate's existence to a merchant that
doesn't own it.

## Money and time

Every amount is a **decimal string** at this boundary (`"15.00"`), converted to/from integer base
units via `@paymap/shared`'s `decimalToBaseUnits`/`baseUnitsToDecimalString` using the asset's
declared `decimals` — set once, on the `Product`. Zero, negative, malformed, and over-precision
amounts are all rejected, never rounded. Every timestamp is ISO 8601, UTC.

`GET /v1/mandates/:id` is the one exception: it reflects live on-chain state for _any_ asset, not
only ones this API's own `Product` catalog knows the decimals for, so its amount fields are named
`*BaseUnits` and returned as plain integer strings rather than formatted decimals.

## Rate limits

| Endpoint                                | Limit                            |
| --------------------------------------- | -------------------------------- |
| merchant auth challenge/complete        | 10 / minute                      |
| merchant profile registration           | 5 / minute                       |
| `POST /v1/merchants/me/api-keys/rotate` | 5 / minute                       |
| charge authorization create/complete    | 30 / minute                      |
| everything else                         | 1000 / minute (generous default) |

All limits are IP-keyed (a documented MVP simplification — merchant-scoped limiting is a future
refinement, not required for this phase).

---

## Endpoints

### Merchant wallet authentication

1. `POST /v1/merchant-auth/challenges` with `{ "walletAddress": "G..." }`.
2. Sign the returned exact `message` with Freighter `signMessage`.
3. `POST /v1/merchant-auth/complete` with the challenge id, message, base64 signature, and signer.
4. Store the returned `pms_live_...` session only in an httpOnly cookie.
5. When `profileRequired` is true, call `POST /v1/merchant-auth/register` with the session and
   business name.

Challenges expire after five minutes and are consumed atomically. The signed message binds the
wallet, Stellar network passphrase, nonce, issue time, expiry, and Paymap authentication purpose.
It does not submit a transaction or move funds.

### `POST /v1/products`

```json
{
  "name": "Pro Plan",
  "description": "Monthly subscription",
  "assetAddress": "CB223…DUZJ",
  "assetDecimals": 7,
  "amountType": "fixed",
  "fixedAmount": "15.00",
  "maxPerPeriod": "15.00",
  "periodSeconds": 2592000,
  "minIntervalSeconds": 0,
  "maxSuccessfulCharges": 0,
  "defaultDurationSeconds": 31536000
}
```

`amountType` is a discriminated union: `"fixed"` requires `fixedAmount`; `"variable"` requires
`maxPerCharge` instead. `maxSuccessfulCharges: 0` means unlimited (mirrors the contract's own
convention).

→ `201`, the created product with amounts rendered back as canonical decimal strings.

### `GET /v1/products/:id`

→ `200` with the same shape, or `404 PRODUCT_NOT_FOUND`.

### `GET /v1/products` (Phase 12b)

Merchant-scoped product catalog, newest first. Query params: `limit` (default 50, max 100).

→ `200` `{ "data": [ { "id": "…", "name": "…", … } ] }` (same product shape as the two endpoints
above)

### `POST /v1/checkout-sessions`

Requires `Idempotency-Key`.

```json
{ "productId": "…", "clientReference": "order-123", "payerAddress": "GABC…" }
```

`expiresAt` defaults to `now + product.defaultDurationSeconds` when omitted.

→ `201`

```json
{
  "id": "…",
  "merchantId": "…",
  "productId": "…",
  "status": "pending",
  "expiresAt": "2026-…Z",
  "createdAt": "2026-…Z"
}
```

### `GET /v1/checkout-sessions/:id`

→ `200`, or `404 CHECKOUT_SESSION_NOT_FOUND`.

### `GET /v1/checkout-sessions` (Phase 12b)

Merchant-scoped checkout-link history, newest first — backs the dashboard's "Checkout links" view.
Query params: `productId` (optional filter), `limit` (default 20, max 100).

→ `200` `{ "data": [ { "id": "…", "productId": "…", "status": "pending", … } ] }`

### `GET /v1/checkout-sessions/:id/public` (Phase 10, unauthenticated)

No `Authorization` header — the consumer checkout page's browser (`apps/web`) opens this directly
and never holds a merchant API key. Returns only display-safe fields (merchant name/wallet
address, the product's mandate terms, session status/expiry/`mandateId`) — never a webhook URL,
webhook secret, or API key. `status` reflects the session's own expiry live (`expired` once past
`expiresAt`, even before a background sweep updates the stored row).

→ `200`

```json
{
  "id": "…",
  "status": "pending",
  "expiresAt": "2026-…Z",
  "mandateId": "…",
  "payerAddress": "…",
  "merchant": { "name": "Acme Coffee Roasters", "walletAddress": "G…" },
  "product": {
    "name": "…",
    "assetAddress": "C…",
    "assetDecimals": 7,
    "amountType": "fixed",
    "fixedAmount": "15.00",
    "maxPerPeriod": "15.00",
    "periodSeconds": 2592000,
    "minIntervalSeconds": 0,
    "maxSuccessfulCharges": 0,
    "defaultDurationSeconds": 31536000
  }
}
```

→ `404 CHECKOUT_SESSION_NOT_FOUND`

### `POST /v1/checkout-sessions/:id/mandate` (Phase 10, unauthenticated)

The checkout page calls this once it has submitted `create_mandate` on-chain, to associate the
resulting `mandate_id` with the session. Also unauthenticated — grants no authority of its own:
the mandate is independently re-verified on-chain (existence, and that its merchant/asset/payer
match this session's product and the supplied `payerAddress`) before anything is persisted.
Idempotent when replayed with the same `mandateId`.

```json
{ "mandateId": "<64 hex chars>", "payerAddress": "GABC…" }
```

→ `200` (the same shape as the `/public` read above, now with `status: "completed"`)

→ `400 MandateNotFound` / `400 MANDATE_MERCHANT_MISMATCH` / `400 MANDATE_ASSET_MISMATCH` /
`400 MANDATE_PAYER_MISMATCH` / `409 CHECKOUT_SESSION_ALREADY_LINKED` /
`409 CHECKOUT_SESSION_NOT_PENDING`

### `GET /v1/mandates/:id`

Reads live on-chain state via `@paymap/contract-client` — never the database. `:id` is the
32-byte hex mandate id.

→ `200`

```json
{
  "id": "…",
  "payer": "GPAYER…",
  "merchant": "GMERCHANT…",
  "asset": "CASSET…",
  "status": "Active",
  "amountRule": { "kind": "fixed", "amountBaseUnits": "150000000" },
  "maxPerPeriodBaseUnits": "150000000",
  "periodSeconds": "2592000",
  "minIntervalSeconds": "0",
  "startAt": "2026-…Z",
  "expiresAt": "2027-…Z",
  "maxSuccessfulCharges": 0,
  "successfulCharges": 3,
  "totalCollectedBaseUnits": "450000000",
  "currentPeriodStart": "2026-…Z",
  "currentPeriodCollectedBaseUnits": "150000000",
  "lastChargedAt": "2026-…Z",
  "createdAt": "2026-…Z"
}
```

`404 MandateNotFound` if it doesn't exist on-chain, **or** if it exists but belongs to a different
merchant (never distinguished — no existence leak).

### `GET /v1/mandates` (Phase 12b)

Merchant-scoped mandate list — backs the dashboard's "Active mandates" and "Upcoming collections"
views. The contract has no "list mandates by merchant" method of its own, so discovery starts from
the `MandateIndex` cache and every row is then re-read live on-chain, exactly like `GET
/v1/mandates/:id` — never the DB cache alone. Query params: `limit` (default 25, max 50).

→ `200`

```json
{
  "data": [
    { "live": true, "mandateId": "…", "mandate": { "id": "…", "status": "Active", … } },
    { "live": false, "mandateId": "…", "cachedStatus": "Active", "lastIndexedAt": "2026-…Z" }
  ]
}
```

A `live: false` row means the on-chain read failed for that one mandate (e.g. transient RPC
trouble) — it degrades to the last-known cached status rather than failing the whole list.

### `POST /v1/mandates/:id/charge-authorizations`

Requires `Idempotency-Key`. Rate-limited (30/min).

```json
{ "amount": "15.00", "invoiceHash": "<64 hex chars>", "scheduledFor": "2026-02-01T00:00:00Z" }
```

`scheduledFor` defaults to now. Before creating anything, this endpoint:

1. Resolves the mandate's asset `decimals` via the `Product` that originated it (a mandate must
   trace back to a `CheckoutSession`/`Product` created through this API — `404
MANDATE_NOT_LINKED_TO_PRODUCT` otherwise).
2. Reads the mandate **on-chain**.
3. Runs a fast precheck mirroring `contracts/mandate-registry/src/charge.rs`'s validation order
   (status, start/expiry, amount rule, min interval, max count, period cap) — a
   deterministically-doomed request (revoked, paused, over-limit, too soon, …) is rejected here,
   with the specific contract error code, and nothing is ever queued for it.

Only then does it create a pending, single-use authorization challenge. The response contains the
unsigned auth-entry XDR, signing preimage XDR, merchant address, contract, network, invocation
display fields, and expiry ledger. It does not create a `ChargeRequest` yet.

→ `201`

```json
{
  "id": "…",
  "mandateId": "…",
  "chargeId": "<64 hex>",
  "amount": "15.00",
  "invoiceHash": "<64 hex>",
  "scheduledFor": "2026-…Z",
  "merchantAddress": "G…",
  "contractId": "C…",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "signatureExpirationLedger": 123456,
  "unsignedAuthorizationEntryXdr": "…",
  "authorizationPreimageXdr": "…",
  "status": "pending"
}
```

### `POST /v1/charge-authorizations/:id/complete`

```json
{ "signedAuthorizationEntryXdr": "…" }
```

The API cryptographically verifies the standard merchant signature and exact issued invocation,
then encrypts the signed XDR and atomically creates the scheduled `ChargeRequest`. Repeating a
successful completion returns the same request. The old `POST /v1/mandates/:id/charges` route
always returns `409 MERCHANT_AUTHORIZATION_REQUIRED`.

The SDK's `charges.create()` performs prepare → merchant `signAuthEntry` → complete as one client
operation. Neither API nor relayer accepts or stores a merchant secret key.

### `GET /v1/charges/:id`

→ `200`, or `404 CHARGE_REQUEST_NOT_FOUND`.

### `GET /v1/charges` (Phase 12b)

Merchant-scoped charge-request list — backs "Upcoming collections" (`scheduled`, not yet due) and
"Failed collections" (`retryable_failed`/`permanently_failed`) on the dashboard. Query params:
`mandateId` (optional filter), `status` (optional, comma-separated — e.g.
`?status=retryable_failed,permanently_failed`; an unrecognized value is rejected with `400
INVALID_STATUS_FILTER` rather than silently ignored), `limit` (default 50, max 100).

→ `200` `{ "data": [ { "id": "…", "status": "permanently_failed", "failureCode": "AmountExceedsChargeLimit", … } ] }`

### `GET /v1/payments`

Query params: `mandateId` (optional filter), `limit` (default 20, max 100).

→ `200` `{ "data": [ { "paymentId": …, "amount": "15.00", … } ] }`

### `POST /v1/payments/:id/refunds`

Requires `Idempotency-Key`.

```json
{ "amount": "5.00" }
```

Verifies the on-chain cumulative refunded total (never trusts the DB cache alone) before
accepting; `422 RefundExceedsPayment` if `refunded + amount` would exceed the original payment.
Creates a `RefundRequest` row in `scheduled` — submission (merchant-authorizes /
relayer-submits, same trust model as a charge) is a later phase; this endpoint only validates and
schedules.

→ `201`

```json
{
  "id": "…",
  "paymentId": "…",
  "refundId": "<64 hex>",
  "amount": "5.00",
  "status": "scheduled",
  "createdAt": "2026-…Z"
}
```

### `GET /v1/refunds` (Phase 12b)

Merchant-scoped refund-request list — backs the dashboard's "Refunds" view. Query params:
`paymentId` (optional filter), `limit` (default 20, max 100).

→ `200` `{ "data": [ { "id": "…", "paymentId": "…", "amount": "5.00", "status": "scheduled", … } ] }`

### `POST /v1/webhook-endpoints` (Phase 12a)

Registers — or rotates, on a repeat call — the merchant's real delivery endpoint. The URL must
pass the SSRF guard below. A fresh secret is generated and shown **exactly once**, here; only its
encrypted form (`WEBHOOK_ENCRYPTION_KEY`, AES-256-GCM) is ever persisted.

```json
{ "url": "https://merchant.example.com/webhooks/paymap" }
```

→ `201`

```json
{ "webhookUrl": "https://merchant.example.com/webhooks/paymap", "webhookSecret": "whsec_…" }
```

Calling this again overwrites the URL and issues a brand-new secret — the old secret stops
verifying immediately. `400 INVALID_URL` / `400 INVALID_PROTOCOL` / `400 INSECURE_PROTOCOL` /
`400 BLOCKED_HOST` / `400 DNS_RESOLUTION_FAILED` if the URL fails the SSRF guard (see below).

### `GET /v1/webhook-endpoints` (Phase 12a)

Status only — never returns the secret in any form.

```json
{ "configured": true, "webhookUrl": "https://merchant.example.com/webhooks/paymap" }
```

### `POST /v1/webhook-endpoints/test`

```json
{ "url": "https://example.com/webhooks/paymap" }
```

Validates the URL against the same SSRF guard as registration, then queues a `webhook.test` event
as a `WebhookDelivery` row in `pending` — the delivery worker (below) actually POSTs it, signed
with whatever secret the merchant currently has registered (via `POST /v1/webhook-endpoints`
above). If no endpoint is registered yet, the row is still queued but the worker dead-letters it
(`WEBHOOK_ENDPOINT_NOT_CONFIGURED`) rather than sending anywhere.

→ `202`

```json
{ "id": "…", "eventId": "<64 hex>", "status": "pending", "createdAt": "2026-…Z" }
```

### `GET /v1/webhook-deliveries` (Phase 12b)

Merchant-scoped delivery history — backs the dashboard's "Webhooks" status/history view. Only
`status`/`attemptCount`/timestamps are returned, never `payload` or anything secret. Query params:
`status` (optional, comma-separated, e.g. `?status=dead_letter`; an unrecognized value is rejected
with `400 INVALID_STATUS_FILTER`), `limit` (default 50, max 100).

→ `200`

```json
{
  "data": [
    {
      "id": "…",
      "eventId": "<64 hex>",
      "eventType": "payment.succeeded",
      "status": "delivered",
      "attemptCount": 1,
      "createdAt": "2026-…Z",
      "updatedAt": "2026-…Z"
    }
  ]
}
```

## Webhooks (Phase 12a)

### Event types

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

Every delivered webhook shares this envelope, assembled fresh by the delivery worker from the
`WebhookDelivery` row's own columns at send time (`eventId` and `eventType` never change across
retries — a receiver can safely dedupe on `eventId` alone):

```json
{
  "eventId": "…",
  "eventType": "payment.succeeded",
  "createdAt": "2026-…Z",
  "signatureVersion": "v1",
  "data": { "…": "…" }
}
```

### Which events actually have a producer today

This is the honest current state, not the aspirational one:

| Event                                                    | Producer                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.succeeded`                                      | `apps/relayer`'s charge pipeline (Phase 9)                                       | Enqueued in the same DB transaction as the `succeeded` transition.                                                                                                                                                                                                                                                                                                                                             |
| `payment.failed`                                         | `apps/relayer`'s charge pipeline (Phase 9)                                       | Enqueued on `permanently_failed` only — a `retry_scheduled` failure does not fire a webhook per attempt.                                                                                                                                                                                                                                                                                                       |
| `mandate.completed`                                      | `apps/relayer`'s charge pipeline (Phase 12a) — **sole producer, see note below** | Detected without an event indexer: the pipeline already holds the _pre-charge_ on-chain `Mandate` (fresh read, step 2) with `successfulCharges`/`maxSuccessfulCharges`; a successful charge that brings the count to exactly the max deterministically completed the mandate (the contract never allows a charge that would exceed it), so the webhook is enqueued alongside `payment.succeeded` in that case. |
| `mandate.active`                                         | `apps/relayer`'s on-chain event indexer (Phase 12c)                              | Indexes the contract's own `mandate_created` event — see below.                                                                                                                                                                                                                                                                                                                                                |
| `mandate.paused` / `mandate.resumed` / `mandate.revoked` | `apps/relayer`'s on-chain event indexer (Phase 12c)                              | Indexes `mandate_paused`/`mandate_resumed`/`mandate_revoked` — see below.                                                                                                                                                                                                                                                                                                                                      |
| `refund.succeeded`                                       | **none**                                                                         | `POST /v1/payments/:id/refunds` only ever creates a `RefundRequest` row in `scheduled` (see that endpoint's docs above) — no relayer pipeline exists yet that actually submits a `refund` transaction on-chain and confirms it. There is no "succeeded" to report.                                                                                                                                             |

### On-chain event indexer (Phase 12c) — how the 4 `mandate.*` lifecycle events got a producer

`create_mandate`/`pause_mandate`/`resume_mandate`/`revoke_mandate` are signed and submitted directly
from the payer's wallet (Phase 10/11) — never routed through this API — so nothing observed them
until this phase. `apps/relayer/src/indexer` polls Soroban RPC's `getEvents` for the
mandate-registry contract's own `#[contractevent]`s (`contracts/mandate-registry/src/events.rs`),
decodes the 5 mandate-lifecycle events, and:

1. Upserts `MandateIndex` from the observed event — chain always wins, keyed by a monotonic ledger
   guard so an out-of-order/replayed event can never regress a row to stale state.
2. Enqueues the mapped webhook (`mandate_created` -> `mandate.active`, `mandate_paused` ->
   `mandate.paused`, `mandate_resumed` -> `mandate.resumed`, `mandate_revoked` -> `mandate.revoked`)
   through the same `WebhookDelivery` path Phase 12a's delivery worker already drains — **no second
   webhook mechanism**.

**`mandate_completed` is the one event this indexer deliberately does not turn into a webhook.**
The charge pipeline already enqueues `mandate.completed` synchronously, in the same transaction as
the charge that completed the mandate — strictly more timely than any poll loop, and the indexer
observing the same on-chain `mandate_completed` event moments later would otherwise produce a
second, redundant `mandate.completed` delivery. The indexer still updates `MandateIndex.status` to
`"Completed"` when it sees this event (chain remains authoritative for status), it just never
enqueues a webhook for it — see `apps/relayer/src/indexer/mandate-index-sync.ts`'s module doc for
the full reasoning.

Deterministic idempotency: `WebhookDelivery.eventId` for every indexer-produced event is
`chain:<rpc event id>` — Soroban RPC's own event id is derived purely from ledger/transaction/
operation/event position, so two indexer instances (or one instance reprocessing after a restart)
observing the identical on-chain event always compute the identical `eventId`, and the table's
unique constraint collapses any duplicate into a no-op insert.

Cursor persistence, restart resumption, and retention-gap detection: see
`docs/architecture.md`'s "Phase 12c — On-chain event indexer" section.

### Signature scheme

HMAC-SHA256, precise enough to reimplement in another language.

**Canonical string** (exactly, no extra separators):

```text
{unixTimestampSeconds}.{eventId}.{rawRequestBodyBytes}
```

`rawRequestBodyBytes` is the _literal_ HTTP body the delivery worker sends — sign the exact string
that will be transmitted, never a re-serialization of the parsed object (whitespace/key-order can
differ and would break verification even for a semantically-identical payload).

**Signature:** `hex(HMAC_SHA256(merchantWebhookSecret, canonicalString))`

**Header:** `Paymap-Signature: t={unixTimestampSeconds},id={eventId},v1={hexSignature}`

All three of timestamp, event id, and signature version live in this one header, exactly as
CLAUDE.md §12 requires. The timestamp is signed (not just attached) specifically so a captured
request can't be replayed later with a forged fresh timestamp — the signature would no longer
match.

**Verification** (what `@paymap/sdk`'s `verifyWebhook` does, and what any independent
implementation should do):

1. Parse `t`, `id`, `v1` out of the `Paymap-Signature` header.
2. Reject if `|now - t| > tolerance` (default 300s, both directions — this is the replay-protection
   check).
3. Recompute `hex(HMAC_SHA256(secret, "{t}.{id}.{rawBody}"))` and compare to `v1` with a
   **constant-time** comparison (`node:crypto`'s `timingSafeEqual`, or your language's
   equivalent) — never `===`/substring, which leaks a timing signal about how many digest bytes
   matched.
4. On success, the event's `id` is stable across every retry of the same event — dedupe on it.

Never include API keys, private keys, webhook secrets, or internal stack traces in the delivered
payload (verified by a dedicated test: `apps/relayer/src/webhook-delivery.test.ts`, "the signed
payload never contains the merchant's API key or webhook secret").

### Delivery state machine

```text
pending → delivering → delivered
pending → delivering → retry_scheduled → delivering → … → dead_letter
```

Guarded, atomic `updateMany` transitions (`apps/api/src/webhook-state-machine.ts`, reused by
`apps/relayer` via the same deep-import-to-built-output convention as `ChargeRequest`'s state
machine) — a concurrent duplicate delivery job loses the claim and makes zero HTTP calls, which is
the actual "duplicate job delivery → exactly one POST" guarantee (not BullMQ's own locking, which
is only a first line of defense).

### Retry / backoff schedule

Exponential, six total attempts (1 initial + 5 retries) before `dead_letter`:

| Attempt | Delay from previous                |
| ------- | ---------------------------------- |
| 1       | immediately (delivery becomes due) |
| 2       | +1 minute                          |
| 3       | +5 minutes                         |
| 4       | +30 minutes                        |
| 5       | +2 hours                           |
| 6       | +6 hours                           |

~8.5 hours total — enough to ride out a typical deploy/incident window on the receiving end
without retrying forever. Defined in `apps/relayer/src/webhook-retry-schedule.ts`.

### Response classification

| Outcome                           | Class     | Behavior                                                      |
| --------------------------------- | --------- | ------------------------------------------------------------- |
| HTTP 2xx                          | success   | → `delivered`                                                 |
| HTTP 408, 429                     | retryable | → `retry_scheduled` (or `dead_letter` if exhausted)           |
| HTTP 5xx                          | retryable | → `retry_scheduled` (or `dead_letter` if exhausted)           |
| HTTP other 4xx                    | permanent | → `dead_letter` immediately, regardless of attempts remaining |
| HTTP 3xx (redirect)               | permanent | Never followed (`redirect: "manual"`) — see SSRF note below   |
| Request timeout (10s)             | retryable | → `retry_scheduled`                                           |
| Network error (DNS/connect/reset) | retryable | → `retry_scheduled`                                           |
| SSRF guard blocked the URL        | permanent | → `dead_letter`                                               |

Defined in `apps/relayer/src/webhook-classify.ts`.

### SSRF protections on webhook URLs

Enforced both at registration (`POST /v1/webhook-endpoints`) and, independently, immediately
before every delivery attempt (`apps/relayer`, since DNS can change between registration and any
given attempt):

- Only `https://` is accepted (never `http://` in production — no env flag defaults it on).
- The hostname's resolved address(es) — literal IP or via DNS — must not fall in a
  loopback/private/link-local/reserved range: IPv4 `127/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16`, `100.64/10` (CGNAT), `0/8`, `224/4`+; IPv6 `::1`, `fc00::/7`, `fe80::/10`, and
  IPv4-mapped addresses checked against the same IPv4 rules (both the dotted and compressed-hex
  forms `::ffff:127.0.0.1` / `::ffff:7f00:1`).
- **DNS rebinding**: the delivery worker doesn't just check-then-reconnect — it _pins_ the actual
  TCP connection to the exact address the check just resolved and approved
  (`undici`'s `Agent({ connect: { lookup } } })`, still using the real hostname for TLS SNI/`Host`),
  so a DNS record that changes between the check and the connect can't redirect the socket.
- **Redirects are never followed** (`redirect: "manual"`) — a URL that itself passed the check
  could otherwise bounce the request somewhere the check never saw; a redirect response is reported
  as a permanent failure instead.

Not covered: this is IP-range-based, not a full egress-network-policy solution — a merchant's own
DNS infrastructure that resolves _at_ the moment of the check to a public IP but is fronted by
something that later proxies to an internal service is outside what an application-level check can
see. `packages/shared/src/webhook-url-guard.ts` documents this precisely.

## `@paymap/sdk`

A small merchant-facing TypeScript SDK (PLAN.md §17). Every mutating method accepts an optional
`idempotencyKey`; a `crypto.randomUUID()` is generated automatically when omitted, so every call is
idempotent-safe by default.

```ts
import { StellarMandates } from "@paymap/sdk";

const mandates = new StellarMandates({
  apiKey: process.env.STELLAR_MANDATES_API_KEY!,
  baseUrl: "https://api.paymap.example/v1", // defaults to http://localhost:3001/v1
});
```

### `checkoutSessions.create`

```ts
const checkout = await mandates.checkoutSessions.create({
  productId: "prod_monthly_ai",
  clientReference: "customer_123",
  successUrl: "https://merchant.example/success",
  cancelUrl: "https://merchant.example/cancel",
});
```

`successUrl`/`cancelUrl` match PLAN.md §17's call shape and are forwarded in the request body, but
are **not yet enforced by the current API version** (`CreateCheckoutSessionSchema` doesn't model a
post-checkout redirect target) — a documented gap, not a silent no-op: they're sent, not dropped,
so a future API version can start honoring them with zero SDK changes.

### `checkoutSessions.get`

```ts
const session = await mandates.checkoutSessions.get("cs_abc123");
```

### `charges.create`

```ts
await mandates.charges.create({
  mandateId: "mandate_...",
  amount: "15.00",
  asset: "USDC",
  invoiceId: "invoice_2026_08_001",
  idempotencyKey: "invoice_2026_08_001",
});
```

`invoiceId` (any merchant-chosen string) is hashed with SHA-256 client-side into the API's required
32-byte `invoiceHash` — deterministically, so retrying with the same `invoiceId` is safe.
`mandateId` becomes the URL path segment; `asset` is accepted for call-shape compatibility but not
sent (the mandate's own on-chain asset is authoritative).

### `charges.get`

```ts
const charge = await mandates.charges.get("cr_abc123");
```

### `payments.list`

```ts
const { data: payments } = await mandates.payments.list({ mandateId: "mandate_..." });
```

### `payments.refunds.create`

```ts
await mandates.payments.refunds.create({
  paymentId: "pay_abc123",
  amount: "5.00",
});
```

### `mandates.get`

```ts
const mandate = await mandates.mandates.get("mandate_...");
console.log(mandate.status); // "Active" | "Paused" | "Revoked" | "Completed" | "Expired"
```

### `verifyWebhook`

```ts
import { verifyWebhook, WebhookSignatureError } from "@paymap/sdk";

// Express: mount with `express.text({ type: "*/*" })` for this route so
// `req.body` is the exact raw string, not pre-parsed JSON.
try {
  const { eventId } = verifyWebhook(
    req.body,
    req.header("Paymap-Signature")!,
    process.env.WEBHOOK_SECRET!,
  );
  const event = JSON.parse(req.body);
  // handle event, deduping on `eventId` (stable across retries)
} catch (error) {
  if (error instanceof WebhookSignatureError) {
    return res.status(400).send(`invalid webhook signature: ${error.code}`); // "MALFORMED_HEADER" | "TIMESTAMP_OUT_OF_TOLERANCE" | "SIGNATURE_MISMATCH"
  }
  throw error;
}
```

### Typed errors

```ts
import { StellarMandatesApiError, StellarMandatesNetworkError } from "@paymap/sdk";

try {
  await mandates.charges.create({ mandateId, amount: "25.00", invoiceId: "inv_1" });
} catch (error) {
  if (error instanceof StellarMandatesApiError) {
    if (error.isContractError()) {
      // error.code is narrowed to one of the 24 frozen mandate-contract error names
      console.log(error.code); // e.g. "AmountExceedsChargeLimit"
    }
    console.log(error.httpStatus, error.code, error.message);
  } else if (error instanceof StellarMandatesNetworkError) {
    // the request itself never got a response (DNS/connect failure, timeout)
  }
}
```

## Running the test suite

```bash
docker compose up -d          # Postgres 16 + Redis 7
pnpm --filter @paymap/api test
```

The `test` script runs `prisma migrate deploy` then `vitest run` against the real Postgres
container — every test in `apps/api` is a real integration test (no mocked database). A fake,
in-memory `MandateReader` stands in for live Soroban RPC (`apps/api/src/chain/mandate-reader.ts`);
production wiring (`apps/api/src/index.ts`) uses the real one, backed by
`@paymap/contract-client` and the committed `deployments/<network>.json` registry.

**Local setup note:** Prisma's CLI (`prisma migrate deploy`) reads `DATABASE_URL` from its own
environment, independent of the Node test process — put a `.env` next to `prisma/schema.prisma`
(gitignored, matching `.env.example`'s `DATABASE_URL`) so the CLI step picks it up; the test
process itself falls back to the same default via `apps/api/vitest.setup.ts` if unset.
