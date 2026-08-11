import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Asset, hash, Keypair, Networks } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";
import { loadDeployment } from "@paymap/contract-client";
import { keypairSigner, signChargeAuthorization, type KeypairSigner } from "@paymap/stellar";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "@paymap/shared";
import { buildApp } from "../../../api/dist/app.js";
import { createChainMandateReader } from "../../../api/dist/chain/mandate-reader.js";
import { createPrismaClient } from "../../../api/dist/db.js";
import { createSorobanChainGateway } from "../../../relayer/dist/chain-gateway.js";
import { processChargeRequest } from "../../../relayer/dist/pipeline.js";
import { createSafeJsonLogger } from "../../../relayer/dist/secure-logger.js";
import { processWebhookDelivery } from "../../../relayer/dist/webhook-delivery.js";

const API_PORT = 4320;
const SIGNER_PORT = 4322;
const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
const TESTNET_FRIENDBOT = "https://friendbot.stellar.org";
const deployment = loadDeployment("testnet");

interface MerchantAuthChallenge {
  challengeId: string;
  message: string;
}

interface MerchantAuthComplete {
  sessionToken: string;
}

interface ProductResponse {
  id: string;
}

interface CheckoutSessionResponse {
  id: string;
}

interface ChargeResponse {
  id: string;
}

interface ChargeAuthorizationChallenge {
  id: string;
  unsignedAuthorizationEntryXdr: string;
  merchantAddress: string;
  contractId: string;
  networkPassphrase: string;
}

interface ReceivedWebhook {
  body: string;
  signature: string;
}

let api: ReturnType<typeof buildApp>;
let prisma: ReturnType<typeof createPrismaClient>;
let signerServer: HttpServer;
let receiverServer: HttpServer;
let payerSigner: KeypairSigner;
let merchantSigner: KeypairSigner;
let relayerSigner: KeypairSigner;
let merchantId: string | undefined;
let merchantApiKey: string;
let checkoutSessionId: string;
let webhookSecret: string;
let webhookEncryptionKey: string;
let authorizationEncryptionKey: string;
let receivedWebhooks: ReceivedWebhook[] = [];
const systemLogger = createSafeJsonLogger("system-e2e", (_level, line) => console.log(line));

async function createAuthorizedCharge(
  mandateId: string,
  payload: { amount: string; invoiceHash: string; scheduledFor?: string },
  idempotencyKey: string,
): Promise<ChargeResponse> {
  const challenge = await apiJson<ChargeAuthorizationChallenge>(
    `/v1/mandates/${mandateId}/charge-authorizations`,
    {
      method: "POST",
      headers: merchantHeaders(merchantApiKey, idempotencyKey),
      body: JSON.stringify(payload),
    },
  );
  const signedAuthorizationEntryXdr = await signChargeAuthorization(
    challenge.unsignedAuthorizationEntryXdr,
    challenge,
    async (preimage) => ({
      signedAuthEntry: merchantSigner.keypair
        .sign(hash(Buffer.from(preimage, "base64")))
        .toString("base64"),
    }),
  );
  return apiJson<ChargeResponse>(`/v1/charge-authorizations/${challenge.id}/complete`, {
    method: "POST",
    headers: merchantHeaders(merchantApiKey),
    body: JSON.stringify({ signedAuthorizationEntryXdr }),
  });
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function createEphemeralSignerServer(signer: KeypairSigner): HttpServer {
  return createServer((request, response) => {
    void (async () => {
      if (request.method === "OPTIONS") {
        jsonResponse(response, 204, {});
        return;
      }
      if (request.method === "GET" && request.url === "/public-key") {
        jsonResponse(response, 200, { publicKey: signer.publicKey });
        return;
      }
      if (request.method === "POST" && request.url === "/sign-transaction") {
        const body = await readJson(request);
        if (typeof body["xdr"] !== "string" || body["networkPassphrase"] !== Networks.TESTNET) {
          jsonResponse(response, 400, { error: "invalid signing request" });
          return;
        }
        const signed = await signer.signTransaction(body["xdr"], {
          networkPassphrase: Networks.TESTNET,
        });
        jsonResponse(response, 200, signed);
        return;
      }
      if (request.method === "POST" && request.url === "/sign-auth-entry") {
        const body = await readJson(request);
        if (
          typeof body["authEntry"] !== "string" ||
          (body["networkPassphrase"] !== undefined &&
            body["networkPassphrase"] !== Networks.TESTNET) ||
          (body["address"] !== undefined && body["address"] !== signer.publicKey)
        ) {
          jsonResponse(response, 400, { error: "invalid signing request" });
          return;
        }
        // SEP-43 signs SHA-256(preimage XDR), matching stellar-sdk's
        // `authorizeEntry` implementation. Signing the raw XDR bytes here
        // would create an invalid Soroban authorization signature.
        const signedAuthEntry = signer.keypair
          .sign(hash(Buffer.from(body["authEntry"], "base64")))
          .toString("base64");
        jsonResponse(response, 200, { signedAuthEntry, signerAddress: signer.publicKey });
        return;
      }
      jsonResponse(response, 404, { error: "not found" });
    })().catch(() => {
      if (!response.headersSent) jsonResponse(response, 500, { error: "signing failed" });
      else response.end();
    });
  });
}

function createWebhookReceiver(): HttpServer {
  return createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/webhooks/paymap") {
        jsonResponse(response, 404, { error: "not found" });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const signature = request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
      if (typeof signature !== "string") {
        jsonResponse(response, 400, { error: "missing signature" });
        return;
      }
      receivedWebhooks.push({ body: Buffer.concat(chunks).toString("utf8"), signature });
      jsonResponse(response, 200, { ok: true });
    })().catch(() => jsonResponse(response, 500, { error: "receiver failed" }));
  });
}

async function listen(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: HttpServer | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fundTestnetAccount(publicKey: string): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${TESTNET_FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`);
    lastStatus = response.status;
    if (response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw new Error(`Friendbot failed to fund runtime test account (status ${String(lastStatus)})`);
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, options);
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "code" in body
        ? String((body as { code: unknown }).code)
        : `HTTP ${String(response.status)}`;
    throw new Error(`API request ${path} failed: ${message}`);
  }
  return body as T;
}

function merchantHeaders(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

test.describe.serial("Phase 13 — real testnet full chain", () => {
  test.beforeAll(async () => {
    if (process.env["SYSTEM_E2E_TESTNET"] !== "1") {
      throw new Error(
        "Refusing live testnet execution. Run via `SYSTEM_E2E_TESTNET=1 pnpm --filter @paymap/web test:e2e:system`.",
      );
    }
    if (
      deployment.networkPassphrase !== Networks.TESTNET ||
      deployment.rpcUrl !== "https://soroban-testnet.stellar.org"
    ) {
      throw new Error(
        "Committed deployment registry is not the expected Stellar testnet deployment.",
      );
    }

    payerSigner = keypairSigner(Keypair.random().secret());
    merchantSigner = keypairSigner(Keypair.random().secret());
    relayerSigner = keypairSigner(Keypair.random().secret());
    receivedWebhooks = [];

    await Promise.all([
      fundTestnetAccount(payerSigner.publicKey),
      fundTestnetAccount(merchantSigner.publicKey),
      fundTestnetAccount(relayerSigner.publicKey),
    ]);

    signerServer = createEphemeralSignerServer(payerSigner);
    receiverServer = createWebhookReceiver();
    await listen(signerServer, SIGNER_PORT);
    await listen(receiverServer, 0);
    const receiverAddress = receiverServer.address();
    if (receiverAddress === null || typeof receiverAddress === "string") {
      throw new Error("webhook receiver did not bind a TCP port");
    }
    const receiverPort = (receiverAddress as AddressInfo).port;

    prisma = createPrismaClient();
    webhookEncryptionKey = randomBytes(32).toString("hex");
    authorizationEncryptionKey = randomBytes(32).toString("hex");
    const apiOptions = {
      prisma,
      mandateReader: createChainMandateReader(deployment),
      hashSecret: randomBytes(32).toString("hex"),
      merchantAuthDomain: "localhost:4321",
      webhookEncryptionKey,
      authorizationEncryptionKey,
      chargeAuthorization: {
        contractId: deployment.contractId,
        networkPassphrase: deployment.networkPassphrase,
      },
      allowInsecureWebhookHttp: true,
      allowPrivateWebhookAddresses: true,
      // Structured API logs are redacted by buildApp; useful when a live
      // RPC/API boundary fails without ever exposing the runtime secrets.
      logger: true,
    };
    api = buildApp(apiOptions);
    await api.listen({ port: API_PORT, host: "127.0.0.1" });

    const challenge = await apiJson<MerchantAuthChallenge>("/v1/merchant-auth/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: merchantSigner.publicKey,
      }),
    });
    const authDigest = createHash("sha256")
      .update("Stellar Signed Message:\n", "utf8")
      .update(challenge.message, "utf8")
      .digest();
    const authenticated = await apiJson<MerchantAuthComplete>("/v1/merchant-auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        message: challenge.message,
        signature: merchantSigner.keypair.sign(authDigest).toString("base64"),
        signerAddress: merchantSigner.publicKey,
      }),
    });
    merchantApiKey = authenticated.sessionToken;
    const merchant = await apiJson<{ merchantId: string }>("/v1/merchant-auth/register", {
      method: "POST",
      headers: merchantHeaders(merchantApiKey),
      body: JSON.stringify({ name: "Phase 13 Testnet Merchant" }),
    });
    merchantId = merchant.merchantId;

    const webhook = await apiJson<{ webhookSecret: string }>("/v1/webhook-endpoints", {
      method: "POST",
      headers: merchantHeaders(merchantApiKey),
      body: JSON.stringify({ url: `http://127.0.0.1:${String(receiverPort)}/webhooks/paymap` }),
    });
    webhookSecret = webhook.webhookSecret;

    const nativeAssetContractId = Asset.native().contractId(Networks.TESTNET);
    const product = await apiJson<ProductResponse>("/v1/products", {
      method: "POST",
      headers: merchantHeaders(merchantApiKey),
      body: JSON.stringify({
        name: "Live Testnet Plan",
        description: "Ephemeral Phase 13 system test",
        assetAddress: nativeAssetContractId,
        assetDecimals: 7,
        amountType: "fixed",
        fixedAmount: "1",
        maxPerPeriod: "2",
        periodSeconds: 86_400,
        minIntervalSeconds: 0,
        maxSuccessfulCharges: 2,
        defaultDurationSeconds: 86_400,
      }),
    });
    const checkout = await apiJson<CheckoutSessionResponse>("/v1/checkout-sessions", {
      method: "POST",
      headers: merchantHeaders(
        merchantApiKey,
        `phase13-checkout-${randomBytes(8).toString("hex")}`,
      ),
      body: JSON.stringify({ productId: product.id, clientReference: "phase13-live-testnet" }),
    });
    checkoutSessionId = checkout.id;
  });

  test.afterAll(async () => {
    await api?.close().catch(() => undefined);
    await close(signerServer).catch(() => undefined);
    await close(receiverServer).catch(() => undefined);

    if (prisma && merchantId) {
      const fixtureMerchantId = merchantId;
      await prisma
        .$transaction([
          prisma.refundRequest.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.payment.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.chargeRequest.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.chargeAuthorization.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.webhookDelivery.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.mandateIndex.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.checkoutSession.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.product.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.idempotencyKey.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.apiKey.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.merchantSession.deleteMany({ where: { merchantId: fixtureMerchantId } }),
          prisma.merchantAuthChallenge.deleteMany({
            where: { walletAddress: merchantSigner.publicKey },
          }),
          prisma.merchant.deleteMany({ where: { id: fixtureMerchantId } }),
        ])
        .catch(() => undefined);
    }
    await prisma?.$disconnect().catch(() => undefined);
  });

  test("checkout → real charge → signed webhook → history → revoke → MandateRevoked", async ({
    page,
  }) => {
    if (!merchantId) throw new Error("system setup did not persist the merchant id");
    const fixtureMerchantId = merchantId;

    await page.goto(`/checkout/${checkoutSessionId}`);
    await expect(page.getByTestId("terms-list")).toContainText("Phase 13 Testnet Merchant");
    await page.getByTestId("connect-wallet-button").click();
    await page.getByTestId("authorize-button").click();
    await expect(page.getByTestId("confirmation-card")).toBeVisible({ timeout: 5 * 60_000 });

    const checkout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutSessionId },
    });
    if (!checkout.mandateId)
      throw new Error("real checkout did not persist its on-chain mandate id");
    const mandateId = checkout.mandateId;

    const firstCharge = await createAuthorizedCharge(
      mandateId,
      { amount: "1", invoiceHash: randomBytes(32).toString("hex") },
      `phase13-charge-1-${randomBytes(8).toString("hex")}`,
    );

    const gateway = createSorobanChainGateway({
      deployment,
      relayerSigner,
    });
    const firstOutcome = await processChargeRequest(
      {
        prisma,
        gateway,
        now: () => new Date(),
        logger: systemLogger,
        authorizationEncryptionKey,
      },
      firstCharge.id,
    );
    expect(firstOutcome).toMatchObject({
      kind: "succeeded",
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const laterCharge = await createAuthorizedCharge(
      mandateId,
      {
        amount: "1",
        invoiceHash: randomBytes(32).toString("hex"),
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      },
      `phase13-charge-2-${randomBytes(8).toString("hex")}`,
    );

    const successDelivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { merchantId: fixtureMerchantId, eventType: "payment.succeeded", status: "pending" },
    });
    const webhookOutcome = await processWebhookDelivery(
      {
        prisma,
        now: () => new Date(),
        webhookEncryptionKey,
        allowInsecureWebhookHttp: true,
        allowPrivateWebhookAddresses: true,
      },
      successDelivery.id,
    );
    expect(webhookOutcome).toEqual({ kind: "delivered" });
    expect(receivedWebhooks).toHaveLength(1);
    const received = receivedWebhooks[0];
    if (!received) throw new Error("local merchant receiver did not receive the webhook");
    verifyWebhookSignature({
      rawBody: received.body,
      header: received.signature,
      secret: webhookSecret,
      now: new Date(),
    });
    expect(JSON.parse(received.body)).toMatchObject({ eventType: "payment.succeeded" });

    await page.goto("/dashboard");
    await page.getByTestId("connect-wallet-button").click();
    await expect(page.locator(`[data-testid="mandate-card-item-${mandateId}"]`)).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId("dashboard-tab-history").click();
    await expect(page.getByTestId("payment-history-success-row")).toContainText(
      "Phase 13 Testnet Merchant",
    );

    await page.getByTestId("dashboard-tab-upcoming").click();
    const card = page.locator(`[data-testid="mandate-card-item-${mandateId}"]`);
    await card.getByTestId("cancel-autopay-button").click();
    const dialog = page.getByTestId("cancel-autopay-dialog");
    await dialog.getByTestId("confirm-cancel-autopay-button").click();
    await expect(dialog.getByText(/set your spending approval to zero/i)).toBeVisible({
      timeout: 5 * 60_000,
    });
    await dialog.getByTestId("set-allowance-zero-button").click();
    await expect(dialog.getByText(/automatic payment cancelled/i)).toBeVisible({
      timeout: 5 * 60_000,
    });

    const laterOutcome = await processChargeRequest(
      {
        prisma,
        gateway,
        now: () => new Date(),
        logger: systemLogger,
        authorizationEncryptionKey,
      },
      laterCharge.id,
    );
    expect(laterOutcome).toEqual({ kind: "permanently_failed", reason: "MandateRevoked" });

    await page.reload();
    await page.getByTestId("connect-wallet-button").click();
    await page.getByTestId("dashboard-tab-history").click();
    const failedRow = page.getByTestId("payment-history-failed-row");
    await expect(failedRow).toContainText("MandateRevoked", { timeout: 60_000 });
    await expect(failedRow).toContainText(/cancelled/i);
  });
});
