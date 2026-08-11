# Demo Script

The scripted end-to-end demo (PLAN.md §23): merchant product creation, checkout link generation,
consumer wallet authorization and mandate creation, a scheduled charge executed by the relayer, an
over-limit charge rejection, immediate revocation, and a subsequently rejected charge attempt —
each step with the exact command or UI action to reproduce it on a clean machine.

Status: Scenes 1-2 are reproducible today (Phase 8 merchant API, Phase 10 consumer checkout).
Scenes 3-5 need Phase 11 (consumer dashboard — "Cancel autopay") and Phase 12 (webhooks) before
they have a UI; the underlying charge/relayer/revocation mechanics they narrate are already proven
end-to-end on real testnet (`scripts/run-relayer-testnet-demo.ts`, `docs/architecture.md`'s Phase 9
section) — only the polished demo narration and the merchant/consumer dashboards around them are
still stubbed. Full polish pass is Phase 15.

---

## Scene 1 — Merchant setup

Create a merchant, then a product matching the pitch example (`$20`/30 days, capped, 12-month
mandate lifetime):

```bash
curl -s -X POST http://localhost:3001/v1/merchants \
  -H 'content-type: application/json' \
  -d '{"name": "CloudBox", "walletAddress": "<merchant G... address>"}'
# -> { "merchantId": "...", "apiKey": "sk_...", ... } — apiKey is shown once, save it.

curl -s -X POST http://localhost:3001/v1/products \
  -H "authorization: Bearer <apiKey>" -H 'content-type: application/json' \
  -d '{
    "name": "CloudBox Pro",
    "assetAddress": "<PUSD SAC contract id, deployments/testnet.json>",
    "assetDecimals": 7,
    "amountType": "variable",
    "maxPerCharge": "20.00",
    "maxPerPeriod": "20.00",
    "periodSeconds": 2592000,
    "minIntervalSeconds": 0,
    "maxSuccessfulCharges": 0,
    "defaultDurationSeconds": 31536000
  }'
# -> { "id": "<productId>", ... }

curl -s -X POST http://localhost:3001/v1/checkout-sessions \
  -H "authorization: Bearer <apiKey>" -H 'content-type: application/json' \
  -H 'idempotency-key: demo-scene-1' \
  -d '{"productId": "<productId>"}'
# -> { "id": "<sessionId>", "status": "pending", ... }
```

The checkout link is `<web app origin>/checkout/<sessionId>`.

## Scene 2 — Consumer authorization

Open `/checkout/<sessionId>` (`apps/web`, Phase 10). Before connecting a wallet, the page already
shows, all on one screen, none collapsed (CLAUDE.md §13):

- Merchant identity and product.
- **Maximum you could ever be charged** — the prominent max-exposure callout
  (`min(max_per_charge × max_charges, max_per_period × periods_until_expiry)`; for this product,
  `max_successful_charges = 0` (unlimited count) so the period bound alone applies: $20 × 12
  periods = $240/year, matching the pitch's "maximum possible yearly debit").
- Every term: asset, amount rule, billing frequency, minimum interval, start date, expiry date,
  maximum charge count.

Steps:

1. Click **Connect your wallet** (Freighter/xBull via Stellar Wallets Kit).
2. Click **Authorize automatic payment** — signs `create_mandate` (payer-signs-and-submits).
3. The page immediately requests the bounded allowance signature — the exact amount (max exposure
   + a disclosed 1% headroom, never unlimited) is shown before signing.
4. Confirmation screen: automatic payment ID, next eligible charge date, approved spending limit,
   and how to cancel.

If step 3 fails after step 2 succeeded, the page shows "created but not funded yet" with a
**Complete the approval** retry action — the payer is never stranded with a half-authorized
mandate they can't find their way back to.

## Scene 3 — Successful collection

*(Mechanics proven end-to-end on testnet in Phase 9 — `scripts/run-relayer-testnet-demo.ts`;
merchant-facing "request a charge" UI lands in Phase 12.)*

The merchant requests a $14.50 charge; the relayer loads the mandate, simulates, submits (merchant
authorizes, relayer only pays the fee and never gains spending authority), and the merchant
receives exactly $14.50 PUSD.

## Scene 4 — Policy protection

*(Contract-level rejection proven by `contracts/mandate-registry`'s `AmountExceedsChargeLimit`/
`AmountExceedsPeriodLimit` test suite; merchant-facing "failed collection" UI lands in Phase 12.)*

The merchant attempts to charge $25 against the $20 mandate; the contract rejects it before any
token transfer.

## Scene 5 — User control

*(Consumer dashboard "Cancel autopay" UI lands in Phase 11; `revoke_mandate` + the post-revoke
`MandateRevoked` charge rejection are already proven by the Phase 2/3 contract test suites.)*

The user taps **Cancel autopay**; a later valid-looking $10 charge is rejected because the mandate
is revoked.

## Final message

> Merchants receive programmable recurring stablecoin payments. Users retain hard on-chain limits
> and instant cancellation.
