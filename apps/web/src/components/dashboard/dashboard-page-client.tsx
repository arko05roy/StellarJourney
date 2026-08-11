"use client";

/**
 * Thin client boundary, mirroring `checkout-page-client.tsx` exactly:
 * decides which `WalletAdapter`/`MandateGateway` implementation to
 * construct (real Stellar Wallets Kit + Soroban gateway, or the
 * deterministic Playwright stubs) and renders `DashboardShell`.
 */
import { useMemo } from "react";
import type { Networks } from "@creit.tech/stellar-wallets-kit";
import { DashboardShell } from "./dashboard-shell";
import { createStellarMandateGateway } from "@/lib/mandate-gateway";
import { createStellarWalletAdapter } from "@/lib/wallet";
import {
  createStubMandateGateway,
  createStubWalletAdapter,
  STUB_PAYER_ADDRESS,
} from "@/lib/test-stubs";
import { createSystemE2EWalletAdapter } from "@/lib/system-e2e-wallet";
import { E2E_ASSET_ADDRESS, E2E_STUB_MANDATES, e2eAllowanceKey } from "@/lib/e2e-stub-fixtures";
// Type-only import: erased at compile time, never pulls the Node-only
// `deployment-registry.js` module into this Client Component's bundle (see
// `checkout-page-client.tsx`'s identical comment).
import type { DeploymentRecord } from "@paymap/contract-client";

export interface DashboardPageClientProps {
  deployment: DeploymentRecord;
}

const USE_STUBS = process.env.NEXT_PUBLIC_E2E_STUBS === "1";
const SYSTEM_E2E_SIGNER_URL = process.env.NEXT_PUBLIC_SYSTEM_E2E_SIGNER_URL;

export function DashboardPageClient({ deployment }: DashboardPageClientProps) {
  const wallet = useMemo(
    () =>
      USE_STUBS
        ? createStubWalletAdapter()
        : SYSTEM_E2E_SIGNER_URL
          ? createSystemE2EWalletAdapter(SYSTEM_E2E_SIGNER_URL)
          : createStellarWalletAdapter(deployment.networkPassphrase as Networks),
    [deployment.networkPassphrase],
  );
  const gateway = useMemo(
    () =>
      USE_STUBS
        ? createStubMandateGateway(
            E2E_STUB_MANDATES(STUB_PAYER_ADDRESS),
            // Seeds a realistic non-zero starting allowance (as if the
            // checkout flow's bounded `approve` had already run) so the
            // dashboard E2E test exercises the real allowance-to-zero
            // prompt, not just the already-zero skip path.
            new Map([
              [
                e2eAllowanceKey(STUB_PAYER_ADDRESS, E2E_ASSET_ADDRESS, deployment.contractId),
                165_750_000n,
              ],
            ]),
          )
        : createStellarMandateGateway(deployment),
    [deployment],
  );

  return <DashboardShell deployment={deployment} wallet={wallet} gateway={gateway} />;
}
