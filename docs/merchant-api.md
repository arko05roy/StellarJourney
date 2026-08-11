# Merchant API

Phase 8. Base URL (local): `http://localhost:3001`. All endpoints are versioned under `/v1`.

The contract is the policy authority (CLAUDE.md §1). This API is a workflow layer around it: it
verifies on-chain mandate state before accepting a charge, schedules work for the relayer
(Phase 9) to execute, and never writes a `Payment` row from its own optimism — only from a
confirmed on-chain result.

## Scope note: endpoints beyond PLAN.md §14's literal list

PLAN.md §14 lists ten endpoints. Two more exist and are documented here, because CLAUDE.md §10
explicitly requires API-key **issuance** and **rotation**, with the full key shown exactly once —
and there is no way to obtain the first key without *some* endpoint:

```text
POST   /v1/merchants                       (bootstrap: create a merchant + first API key)
POST   /v1/merchants/me/api-keys/rotate    (rotate: issue a new key, revoke the old one)
```

Everything else matches PLAN.md §14 exactly.

## Authentication

Every endpoint except `POST /v1/merchants` requires:

```text
Authorization: Bearer <api key>
```

API keys look like `sk_live_<random>`. They are **hashed at rest** with HMAC-SHA256, using
`API_KEY_HASH_SECRET` as the pepper (never a bare hash — the secret must matter, or a stolen
database dump alone would be dictionary-attackable). Verification is a constant-time comparison
of the full digest (`node:crypto`'s `timingSafeEqual`), not a substring/prefix check.

The **full key is shown exactly once** — at creation, and again at rotation. It is never stored
in recoverable form and never returned by any other endpoint.

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

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MISSING_API_KEY` | 401 | No `Authorization` header, or not `Bearer <key>` shaped. |
| `INVALID_API_KEY` | 401 | Header present but no stored key hash matches. |
| `API_KEY_REVOKED` | 401 | The hash matches a key that has since been rotated out. |
| `MERCHANT_DISABLED` | 403 | The key is valid but the merchant account itself is disabled. |

## Idempotency

Required (`Idempotency-Key` header) on:

```text
POST /v1/checkout-sessions
POST /v1/mandates/:id/charges
POST /v1/payments/:id/refunds
```

Missing header → `400 MISSING_IDEMPOTENCY_KEY`.

**Contract:** the same `(merchant, Idempotency-Key)` pair with the **same** request body replays
the original response verbatim (including the original HTTP status) — the side-effecting write
never runs twice. The same key with a **different** body is rejected:

```json
{ "code": "IDEMPOTENCY_KEY_REUSED", "message": "This Idempotency-Key was already used with a different request body." }
```

**Concurrency safety:** one Postgres transaction wraps the idempotency-record insert, the
side-effecting write, and the response write, together. A concurrent, identical request's insert
blocks on Postgres's own MVCC conflict resolution until the first transaction commits, then finds
the already-completed row and replays it — never a second execution, never a half-written record.
See `apps/api/src/idempotency/middleware.ts`'s module doc for the exact mechanism (including why a
naive `catch` around a failed insert does not work — it poisons the enclosing transaction).

A request rejected by validation or the on-chain precheck *before* idempotency is invoked (e.g. a
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

| Contract code | HTTP | Retryable (relayer) |
| --- | --- | --- |
| `MandateNotFound` | 404 | no |
| `MandateNotActive` | 409 | no |
| `MandatePaused` | 409 | no |
| `MandateRevoked` | 409 | no |
| `MandateCompleted` | 409 | no |
| `MandateExpired` | 409 | no |
| `ChargeBeforeStart` | 409 | no |
| `ChargeTooSoon` | 409 | no |
| `InvalidAmount` | 422 | no |
| `AmountExceedsChargeLimit` | 422 | no |
| `AmountExceedsPeriodLimit` | 422 | no |
| `ChargeCountExceeded` | 409 | no |
| `DuplicateCharge` | 409 | no |
| `UnauthorizedMerchant` | 403 | no |
| `InsufficientAllowance` | 402 | yes (merchant policy) |
| `InsufficientBalance` | 402 | yes (merchant policy) |
| `PaymentNotFound` | 404 | no |
| `RefundExceedsPayment` | 422 | no |
| `DuplicateRefund` | 409 | no |
| `ArithmeticOverflow` | 500 | no |
| `InvalidMandateInput` | 400 | no |
| `DuplicateMandate` | 409 | no |
| `InvalidStateTransition` | 409 | no |
| `RefundNotFound` | 404 | no |

### Other stable codes

| Code | HTTP | Where |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | any endpoint — Zod rejection, `details` lists each issue |
| `MISSING_IDEMPOTENCY_KEY` | 400 | the three idempotent POSTs |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different body |
| `INVALID_AMOUNT` | 400 | decimal→base-unit conversion failure (zero, over-precision, malformed) |
| `MANDATE_NOT_LINKED_TO_PRODUCT` | 404 | charge/refund on a mandate with no checkout-session/product to resolve `decimals` from |
| `RATE_LIMITED` | 429 | rate-limited endpoints |
| `PRODUCT_NOT_FOUND`, `CHECKOUT_SESSION_NOT_FOUND`, `CHARGE_REQUEST_NOT_FOUND` | 404 | resource not found or not owned by this merchant |
| `INTERNAL_ERROR` | 500 | genuinely unexpected failure only |

`MandateNotFound` is also returned (never a distinct "forbidden" code) when a mandate exists but
belongs to a different merchant — this API never reveals a mandate's existence to a merchant that
doesn't own it.

## Money and time

Every amount is a **decimal string** at this boundary (`"15.00"`), converted to/from integer base
units via `@paymap/shared`'s `decimalToBaseUnits`/`baseUnitsToDecimalString` using the asset's
declared `decimals` — set once, on the `Product`. Zero, negative, malformed, and over-precision
amounts are all rejected, never rounded. Every timestamp is ISO 8601, UTC.

`GET /v1/mandates/:id` is the one exception: it reflects live on-chain state for *any* asset, not
only ones this API's own `Product` catalog knows the decimals for, so its amount fields are named
`*BaseUnits` and returned as plain integer strings rather than formatted decimals.

## Rate limits

| Endpoint | Limit |
| --- | --- |
| `POST /v1/merchants` | 5 / minute |
| `POST /v1/merchants/me/api-keys/rotate` | 5 / minute |
| `POST /v1/mandates/:id/charges` | 30 / minute |
| everything else | 1000 / minute (generous default) |

All limits are IP-keyed (a documented MVP simplification — merchant-scoped limiting is a future
refinement, not required for this phase).

---

## Endpoints

### `POST /v1/merchants`

No authentication (this *is* the bootstrap). Rate-limited.

```json
{ "name": "Acme Inc", "walletAddress": "GABC...5EQQ" }
```

→ `201`

```json
{ "merchantId": "…", "name": "Acme Inc", "walletAddress": "GABC...5EQQ", "apiKeyId": "…", "apiKey": "sk_live_…" }
```

`apiKey` is shown once, here.

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

### `POST /v1/checkout-sessions`

Requires `Idempotency-Key`.

```json
{ "productId": "…", "clientReference": "order-123", "payerAddress": "GABC…" }
```

`expiresAt` defaults to `now + product.defaultDurationSeconds` when omitted.

→ `201`

```json
{ "id": "…", "merchantId": "…", "productId": "…", "status": "pending", "expiresAt": "2026-…Z", "createdAt": "2026-…Z" }
```

### `GET /v1/checkout-sessions/:id`

→ `200`, or `404 CHECKOUT_SESSION_NOT_FOUND`.

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
  "product": { "name": "…", "assetAddress": "C…", "assetDecimals": 7, "amountType": "fixed", "fixedAmount": "15.00", "maxPerPeriod": "15.00", "periodSeconds": 2592000, "minIntervalSeconds": 0, "maxSuccessfulCharges": 0, "defaultDurationSeconds": 31536000 }
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

### `POST /v1/mandates/:id/charges`

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

Only then does it create a `ChargeRequest` row in `scheduled` — **it does not charge
synchronously**. Phase 9's relayer drives it from there.

→ `201`

```json
{
  "id": "…", "mandateId": "…", "chargeId": "<64 hex>", "amount": "15.00",
  "invoiceHash": "<64 hex>", "scheduledFor": "2026-…Z", "status": "scheduled",
  "attemptCount": 0, "createdAt": "2026-…Z"
}
```

### `GET /v1/charges/:id`

→ `200`, or `404 CHARGE_REQUEST_NOT_FOUND`.

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
{ "id": "…", "paymentId": "…", "refundId": "<64 hex>", "amount": "5.00", "status": "scheduled", "createdAt": "2026-…Z" }
```

### `POST /v1/webhook-endpoints/test`

```json
{ "url": "https://example.com/webhooks/paymap" }
```

Non-`http(s)` URLs are rejected (`400 VALIDATION_ERROR`). Queues a `webhook.test` event as a
`WebhookDelivery` row in `pending` — **no live HTTP call is made** (the delivery worker is Phase
12; making a real outbound request here would also need the SSRF hardening Phase 14 adds).

→ `202`

```json
{ "id": "…", "eventId": "<64 hex>", "status": "pending", "createdAt": "2026-…Z" }
```

## Webhook event types (payload shape only — delivery is Phase 12)

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

Every delivered webhook shares this envelope (CLAUDE.md §12):

```json
{ "eventId": "…", "eventType": "payment.succeeded", "createdAt": "2026-…Z", "signatureVersion": "v1", "data": { "…": "…" } }
```

HMAC-SHA256 signing, retries, and the delivery state machine (`pending → delivering → delivered |
retry_scheduled → dead_letter`) are Phase 12 scope.

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
