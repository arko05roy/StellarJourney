#!/usr/bin/env node
/**
 * Minimal stand-in for the merchant API's public checkout endpoints
 * (`apps/api/src/routes/checkout-sessions.ts`'s `/public` and `/mandate`
 * routes) and consumer discovery endpoints (`apps/api/src/routes/consumer.ts`),
 * used by the Playwright happy-path tests (`e2e/checkout.spec.ts`,
 * `e2e/dashboard.spec.ts`). Deliberately plain Node (`node:http`, no
 * framework, no TypeScript build step) so it starts in milliseconds as one
 * of `playwright.config.ts`'s `webServer` entries — this is a network-layer
 * stub, not a re-implementation of the real API's validation/idempotency
 * logic, which is exercised for real by `apps/api`'s own test suite.
 *
 * The checkout page's Server Component (`app/checkout/[sessionId]/page.tsx`)
 * fetches the public session from the *server* side, so this has to be a
 * real HTTP server the Next.js process can reach — Playwright's
 * browser-level `page.route()` interception can't see that request at all.
 * The dashboard's discovery/history fetches happen client-side, but are
 * routed through this same server for consistency (one mock backend for
 * the whole `apps/web` E2E suite).
 *
 * The consumer/dashboard fixture ids below must exactly match
 * `src/lib/e2e-stub-fixtures.ts` and `src/lib/test-stubs.ts`'s
 * `STUB_PAYER_ADDRESS` — this "database" half and the stub `MandateGateway`
 * "chain" half must agree on the same mandate for the dashboard to tell a
 * consistent story.
 */
import { createServer } from "node:http";

const E2E_MANDATE_ID = "1".repeat(64);
const E2E_MERCHANT_ADDRESS = `G${"M".repeat(55)}`;
const E2E_ASSET_ADDRESS = `C${"A".repeat(55)}`;
const E2E_PAYER_ADDRESS = "GATESTSTUBPAYERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const E2E_MERCHANT_NAME = "Acme Coffee Roasters";

export const SESSION_ID = "e2e-happy-path-session";
const PORT = Number(process.env.MOCK_API_PORT ?? 4310);

const PRODUCT = {
  id: "prod-e2e",
  name: "Studio Membership",
  description: "Monthly access to the Acme Coffee Roasters subscriber tier.",
  assetAddress: `C${"A".repeat(55)}`,
  assetDecimals: 7,
  amountType: "fixed",
  fixedAmount: "15.00",
  maxPerPeriod: "15.00",
  periodSeconds: 2_592_000,
  minIntervalSeconds: 86_400,
  maxSuccessfulCharges: 12,
  defaultDurationSeconds: 31_536_000,
  active: true,
  createdAt: new Date().toISOString(),
};

const MERCHANT = { name: "Acme Coffee Roasters", walletAddress: `G${"M".repeat(55)}` };

let mandateId;
let payerAddress;

function sessionBody() {
  return {
    id: SESSION_ID,
    status: mandateId ? "completed" : "pending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    mandateId,
    payerAddress,
    merchant: MERCHANT,
    product: PRODUCT,
  };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  // Mirrors apps/api's own permissive CORS for these public endpoints
  // (`app.ts`'s `@fastify/cors` registration) — without this, the browser
  // blocks the checkout page's fetch calls before they ever reach this
  // stub, since the Next.js dev server and this mock run on different
  // ports (different origins).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === `/v1/checkout-sessions/${SESSION_ID}/public`) {
    send(res, 200, sessionBody());
    return;
  }

  if (req.method === "POST" && url.pathname === `/v1/checkout-sessions/${SESSION_ID}/mandate`) {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        mandateId = parsed.mandateId;
        payerAddress = parsed.payerAddress;
        send(res, 200, sessionBody());
      } catch {
        send(res, 400, { code: "INVALID_BODY", message: "could not parse request body" });
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/consumer/mandates") {
    const payerAddress = url.searchParams.get("payerAddress");
    const data =
      payerAddress === E2E_PAYER_ADDRESS
        ? [
            {
              mandateId: E2E_MANDATE_ID,
              merchant: { name: E2E_MERCHANT_NAME, walletAddress: E2E_MERCHANT_ADDRESS },
              assetAddress: E2E_ASSET_ADDRESS,
              assetDecimals: 7,
              cachedStatus: "Active",
              lastIndexedAt: new Date().toISOString(),
            },
          ]
        : [];
    send(res, 200, { data });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/consumer/payments") {
    const payerAddress = url.searchParams.get("payerAddress");
    if (payerAddress !== E2E_PAYER_ADDRESS) {
      send(res, 200, { payments: [], failedAttempts: [] });
      return;
    }
    send(res, 200, {
      payments: [
        {
          paymentId: "2".repeat(64),
          mandateId: E2E_MANDATE_ID,
          chargeId: "3".repeat(64),
          merchant: { name: E2E_MERCHANT_NAME, walletAddress: E2E_MERCHANT_ADDRESS },
          amount: "15.0000000",
          assetAddress: E2E_ASSET_ADDRESS,
          transactionHash: "4".repeat(64),
          createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      failedAttempts: [
        {
          id: "failed-attempt-1",
          mandateId: E2E_MANDATE_ID,
          chargeId: "5".repeat(64),
          merchant: { name: E2E_MERCHANT_NAME, walletAddress: E2E_MERCHANT_ADDRESS },
          amount: "50.0000000",
          status: "permanently_failed",
          failureCode: "AmountExceedsChargeLimit",
          attemptedAt: new Date(Date.now() - 43_200_000).toISOString(),
        },
      ],
    });
    return;
  }

  send(res, 404, { code: "NOT_FOUND", message: `no mock route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`[mock-api-server] listening on http://localhost:${String(PORT)}`);
});
