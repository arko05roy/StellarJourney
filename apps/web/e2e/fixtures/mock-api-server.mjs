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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Merchant dashboard fixtures: wallet session -> create product -> generate
// checkout link -> view mandates -> view a failed collection -> create a
// scoped API key. Deliberately minimal — only the routes that flow actually
// exercises, matching this file's existing "network-layer stub, not a
// re-implementation" scope.
//
// Keyed by opaque session/API credentials, not one shared module-level object:
// `playwright.config.ts` sets `fullyParallel: true`, and this one mock
// process is shared by every test in the file (a real webServer, not a
// per-test fixture). Each account keeps its own products, checkout sessions,
// and integration keys so parallel tests cannot stomp shared state.
// ---------------------------------------------------------------------------
const merchantAccountsByWallet = new Map();
const merchantAccountsByApiKey = new Map();
const merchantSessions = new Map();
const merchantChallenges = new Map();
let merchantAccountSeq = 0;
let merchantKeySeq = 0;
let merchantSessionSeq = 0;
let merchantChallengeSeq = 0;

const E2E_MERCHANT_MANDATE_ID = "9".repeat(64);
const E2E_MERCHANT_PAYER_ADDRESS = "GATESTMERCHANTFLOWPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/** Returns the authenticated account, or sends a 401 and returns `undefined`. */
function requireMerchantAuth(req, res) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const account = match
    ? (merchantSessions.get(match[1])?.account ?? merchantAccountsByApiKey.get(match[1]))
    : undefined;
  if (!account) {
    send(res, 401, { code: "MISSING_API_KEY", message: "invalid or missing API key" });
    return undefined;
  }
  return account;
}

function toMerchantProductResponse(product) {
  return { ...product };
}

const server = createServer(async (req, res) => {
  // Mirrors apps/api's own permissive CORS for these public endpoints
  // (`app.ts`'s `@fastify/cors` registration) — without this, the browser
  // blocks the checkout page's fetch calls before they ever reach this
  // stub, since the Next.js dev server and this mock run on different
  // ports (different origins).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST",
      "access-control-allow-headers": "content-type, authorization, idempotency-key",
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

  // -------------------------------------------------------------------------
  // Merchant dashboard routes
  // -------------------------------------------------------------------------

  if (req.method === "POST" && url.pathname === "/v1/merchant-auth/challenges") {
    const body = await readJsonBody(req).catch(() => ({}));
    merchantChallengeSeq += 1;
    const challengeId = `00000000-0000-4000-8000-${String(merchantChallengeSeq).padStart(12, "0")}`;
    const message = `Paymap merchant authentication\nWallet: ${body.walletAddress ?? ""}\nChallenge: ${challengeId}`;
    merchantChallenges.set(challengeId, {
      walletAddress: body.walletAddress ?? "",
      message,
    });
    send(res, 201, {
      challengeId,
      message,
      networkPassphrase: "Test SDF Network ; September 2015",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/merchant-auth/complete") {
    const body = await readJsonBody(req).catch(() => ({}));
    const challenge = merchantChallenges.get(body.challengeId);
    if (!challenge || challenge.message !== body.message) {
      send(res, 401, { code: "INVALID_AUTH_CHALLENGE", message: "invalid challenge" });
      return;
    }
    merchantSessionSeq += 1;
    const sessionToken = `pms_e2e_${String(merchantSessionSeq)}`;
    const account = merchantAccountsByWallet.get(challenge.walletAddress);
    merchantSessions.set(sessionToken, {
      walletAddress: challenge.walletAddress,
      account,
    });
    merchantChallenges.delete(body.challengeId);
    send(res, 201, {
      sessionToken,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      profileRequired: !account,
      ...(account
        ? {
            merchant: {
              id: account.id,
              name: account.name,
              walletAddress: account.walletAddress,
            },
          }
        : {}),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/merchant-auth/register") {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const session = match ? merchantSessions.get(match[1]) : undefined;
    if (!session) {
      send(res, 401, { code: "INVALID_MERCHANT_SESSION", message: "invalid session" });
      return;
    }
    const body = await readJsonBody(req).catch(() => ({}));
    merchantAccountSeq += 1;
    const account = {
      id: `merchant-e2e-${String(merchantAccountSeq)}`,
      name: body.name ?? "",
      walletAddress: session.walletAddress,
      apiKeys: [],
      products: [],
      checkoutSessions: [],
      productSeq: 0,
      sessionSeq: 0,
    };
    merchantAccountsByWallet.set(account.walletAddress, account);
    session.account = account;
    send(res, 201, {
      merchantId: account.id,
      name: account.name,
      walletAddress: account.walletAddress,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/merchant-auth/logout") {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (match) merchantSessions.delete(match[1]);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/merchants/me/api-keys") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    send(res, 200, { data: account.apiKeys });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/merchants/me/api-keys") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    const body = await readJsonBody(req).catch(() => ({}));
    merchantKeySeq += 1;
    const apiKeyId = `key-${String(merchantKeySeq)}`;
    const apiKey = `sk_live_e2e_${String(merchantKeySeq)}`;
    const key = {
      id: apiKeyId,
      name: body.name ?? "",
      keyPrefix: apiKey.slice(0, 15),
      scopes: body.scopes ?? [],
      status: "active",
      createdAt: new Date().toISOString(),
    };
    account.apiKeys.push(key);
    merchantAccountsByApiKey.set(apiKey, account);
    send(res, 201, { apiKeyId, name: key.name, scopes: key.scopes, apiKey });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/v1/merchants/me/api-keys/")) {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    const keyId = url.pathname.split("/").at(-1);
    const key = account.apiKeys.find((candidate) => candidate.id === keyId);
    if (key) key.status = "revoked";
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/webhook-endpoints") {
    if (!requireMerchantAuth(req, res)) return;
    send(res, 200, { configured: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/products") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    send(res, 200, { data: account.products.map(toMerchantProductResponse) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/products") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    const body = await readJsonBody(req).catch(() => ({}));
    account.productSeq += 1;
    const product = {
      id: `e2e-product-${account.id}-${String(account.productSeq)}`,
      name: body.name,
      description: body.description,
      assetAddress: body.assetAddress,
      assetDecimals: body.assetDecimals,
      amountType: body.amountType,
      fixedAmount: body.amountType === "fixed" ? body.fixedAmount : undefined,
      maxPerCharge: body.amountType === "variable" ? body.maxPerCharge : undefined,
      maxPerPeriod: body.maxPerPeriod,
      periodSeconds: body.periodSeconds,
      minIntervalSeconds: body.minIntervalSeconds,
      maxSuccessfulCharges: body.maxSuccessfulCharges,
      defaultDurationSeconds: body.defaultDurationSeconds,
      active: true,
      createdAt: new Date().toISOString(),
    };
    account.products.unshift(product);
    send(res, 201, toMerchantProductResponse(product));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/checkout-sessions") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    send(res, 200, { data: account.checkoutSessions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/checkout-sessions") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    const body = await readJsonBody(req).catch(() => ({}));
    account.sessionSeq += 1;
    const session = {
      id: `e2e-merchant-session-${account.id}-${String(account.sessionSeq)}`,
      merchantId: account.id,
      productId: body.productId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    account.checkoutSessions.unshift(session);
    send(res, 201, session);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/mandates") {
    const account = requireMerchantAuth(req, res);
    if (!account) return;
    send(res, 200, {
      data: [
        {
          live: true,
          mandateId: E2E_MERCHANT_MANDATE_ID,
          mandate: {
            id: E2E_MERCHANT_MANDATE_ID,
            payer: E2E_MERCHANT_PAYER_ADDRESS,
            merchant: account.walletAddress,
            asset: E2E_ASSET_ADDRESS,
            status: "Active",
            amountRule: { kind: "fixed", amountBaseUnits: "150000000" },
            maxPerPeriodBaseUnits: "150000000",
            periodSeconds: "2592000",
            minIntervalSeconds: "86400",
            startAt: new Date(Date.now() - 86_400_000).toISOString(),
            expiresAt: new Date(Date.now() + 31_536_000_000).toISOString(),
            maxSuccessfulCharges: 12,
            successfulCharges: 1,
            totalCollectedBaseUnits: "150000000",
            currentPeriodStart: new Date(Date.now() - 86_400_000).toISOString(),
            currentPeriodCollectedBaseUnits: "150000000",
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
          },
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/charges") {
    if (!requireMerchantAuth(req, res)) return;
    send(res, 200, {
      data: [
        {
          id: "e2e-failed-charge-1",
          mandateId: E2E_MERCHANT_MANDATE_ID,
          chargeId: "8".repeat(64),
          amount: "999.0000000",
          invoiceHash: "7".repeat(64),
          scheduledFor: new Date().toISOString(),
          status: "permanently_failed",
          attemptCount: 1,
          failureCode: "AmountExceedsChargeLimit",
          createdAt: new Date().toISOString(),
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
