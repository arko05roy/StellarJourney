# Merchant API

This document will describe every public merchant API endpoint (products, checkout sessions,
charge requests, refunds, webhooks), its Zod-validated request/response shape, required
`Idempotency-Key` usage, authentication via hashed API keys, and a minimal working example for
every SDK method that wraps it (CLAUDE.md §10, §12).

Status: stub, filled in Phase 8 (merchant API) and extended in Phase 12 (SDK).
