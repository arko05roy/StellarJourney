# Demo Script

The scripted end-to-end demo (PLAN.md §23): merchant product creation, checkout link generation,
consumer wallet authorization and mandate creation, a scheduled charge executed by the relayer, an
over-limit charge rejection, immediate revocation, and a subsequently rejected charge attempt —
each step with the exact command or UI action to reproduce it on a clean machine.

Status: complete in Phase 15. The UI supports merchant setup, wallet authorization, live mandate
controls, and a unified transaction timeline. `pnpm demo:scenes` runs the exact real-testnet
success → over-limit rejection → revocation → post-revocation rejection sequence through the
actual contract and relayer pipeline.

## Clean run

```bash
pnpm install --frozen-lockfile
pnpm demo:setup
pnpm start
```

In another shell:

```bash
pnpm demo:scenes
```

`demo:setup` creates the merchant, consumer, fixed plan, variable plan, and checkout links without
printing any private key. See the root `README.md` for prerequisites and deployment ids.

---

## Scene 1 — Merchant setup

### Via the dashboard (Phase 12b, preferred for the live demo)

1. Open `/merchant/connect` (`apps/web`). Fill in **"New to Paymap"** with a business name and the
   merchant's Stellar wallet address, submit — the API key is shown exactly once; copy it (CLAUDE.md
   §10 — it cannot be shown again, though the session itself stays connected via an httpOnly cookie).
2. **Products -> New product.** Fill in the pitch example: variable up to `$20`, `2592000`-second
   (30-day) period, `20.00` max per period, `0` minimum interval, unlimited charge count, `31536000`
   second (12-month) mandate lifetime. Submit — every term here becomes part of the mandate the payer
   authorizes, nothing adjustable later.
3. **Checkout links.** Select the new product, click **Generate checkout link**, then **Copy link**.

### Via curl (equivalent, scriptable)

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
   - a disclosed 1% headroom, never unlimited) is shown before signing.
4. Confirmation screen: automatic payment ID, next eligible charge date, approved spending limit,
   and how to cancel.

If step 3 fails after step 2 succeeded, the page shows "created but not funded yet" with a
**Complete the approval** retry action — the payer is never stranded with a half-authorized
mandate they can't find their way back to.

## Scene 3 — Successful collection

Run `pnpm demo:scenes`. The first scene schedules a real request and executes it through
`processChargeRequest` against testnet. In the UI, the result appears on the merchant Payments view
and the consumer's **Transaction timeline** with its transaction hash.

The merchant requests a $14.50 charge; the relayer loads the mandate, simulates, submits (merchant
authorizes, relayer only pays the fee and never gains spending authority), and the merchant
receives exactly $14.50 PUSD.

## Scene 4 — Policy protection

The second `pnpm demo:scenes` step submits twice the fixed limit through the same relayer pipeline.
It must finish as `AmountExceedsChargeLimit`, with no token movement. The rejection appears in the
merchant Failed view and consumer transaction timeline.

The merchant attempts to charge $25 against the $20 mandate; the contract rejects it before any
token transfer.

## Scene 5 — User control

Open `/dashboard` (`apps/web`, Phase 11) with the wallet that authorized Scene 2's mandate.
Before doing anything, the dashboard already shows every mandate field CLAUDE.md §13 requires,
read live from the contract, never the database: merchant, asset, amount/maximum, billing
frequency, next eligible charge date, period usage (as a meter), expiry, and status.

Steps:

1. From the **Upcoming** or **Active** tab, click **Pause** on the CloudBox mandate — a single
   payer-signed `pause_mandate` call. The status badge flips to "Paused" and the mandate moves to
   the **Paused & ended** tab (no more eligible-charge date while paused).
2. Click **Resume** — `resume_mandate`, payer-signed, moves back to **Active**/**Upcoming**.
3. Click **Cancel autopay**. The confirmation dialog states plainly this is immediate, permanent,
   and needs no merchant approval (PLAN.md §10.9). Confirming signs `revoke_mandate` — the mandate
   is cancelled the instant that transaction confirms, full stop.
4. The dashboard immediately follows up with the allowance-to-zero prompt: "Set your spending
   approval to zero?", explaining that a lingering token allowance is a standing risk even though
   the cancelled mandate itself now blocks every future charge. Clicking **Set to zero** signs one
   more `approve(amount: 0)` transaction. Declining (**Skip for now**) is equally valid — the
   mandate is already safely cancelled either way.
5. Back on **Paused & ended**, the mandate now shows "Cancelled" with no lifecycle controls left,
   just "View history".
6. The final `pnpm demo:scenes` step attempts a later, otherwise-valid charge against the same
   mandate id — rejected with `MandateRevoked` before
   any token transfer, proven by the Phase 2/3 contract test suites. On the consumer's **Payment
   history** tab, this shows up not as a scary error but as a blocked attempt: "The merchant tried
   to charge after you cancelled this automatic payment, so we blocked it" — proof the protection
   works, with the machine code (`MandateRevoked`) shown alongside for support.

## Final message

> Merchants receive programmable recurring stablecoin payments. Users retain hard on-chain limits
> and instant cancellation.
