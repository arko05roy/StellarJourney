/**
 * The one fixture mandate shared between the dashboard Playwright test
 * (`e2e/dashboard.spec.ts`), the stub `MandateGateway` (`lib/test-stubs.ts`),
 * and the mock API server (`e2e/fixtures/mock-api-server.mjs`) — all three
 * must agree on the same `mandateId`/`assetAddress`/merchant identity for
 * the "chain" (stub gateway) and "database" (mock API) halves of the
 * dashboard to tell a consistent story. Kept in one file, imported by the
 * client-side stub wiring only (`dashboard-page-client.tsx`, itself only
 * reachable when `NEXT_PUBLIC_E2E_STUBS=1` — see that module's doc).
 */
import type { Mandate } from "@paymap/contract-client";

export const E2E_MANDATE_ID = "1".repeat(64);
export const E2E_MERCHANT_ADDRESS = `G${"M".repeat(55)}`;
export const E2E_ASSET_ADDRESS = `C${"A".repeat(55)}`;

const DAY = 86_400n;

/** Same key format as `test-stubs.ts::createStubMandateGateway`'s internal allowance map — used to seed a realistic non-zero starting allowance for the dashboard E2E test's cancel-autopay flow. */
export function e2eAllowanceKey(payerAddress: string, tokenContractId: string, spender: string): string {
  return `${payerAddress}:${tokenContractId}:${spender}`;
}

/** A single `Active`, fixed-amount mandate — enough to exercise list -> pause -> resume -> cancel autopay -> allowance prompt end to end. */
export function E2E_STUB_MANDATES(payerAddress: string): Mandate[] {
  const startAt = BigInt(Math.floor(Date.now() / 1000)) - DAY;
  return [
    {
      id: E2E_MANDATE_ID,
      payer: payerAddress,
      merchant: E2E_MERCHANT_ADDRESS,
      asset: E2E_ASSET_ADDRESS,
      status: "Active",
      amountRule: { kind: "fixed", amount: 150_000_000n }, // 15.00 at 7 decimals
      maxPerPeriod: 150_000_000n,
      periodSeconds: DAY * 30n,
      minIntervalSeconds: 0n,
      startAt,
      expiresAt: startAt + DAY * 365n,
      maxSuccessfulCharges: 12,
      successfulCharges: 0,
      totalCollected: 0n,
      currentPeriodStart: startAt,
      currentPeriodCollected: 0n,
      lastChargedAt: undefined,
      createdAt: startAt,
      metadataHash: "0".repeat(64),
    },
  ];
}
