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
