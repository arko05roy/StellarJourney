"use client";

/**
 * Thin client boundary: decides which `WalletAdapter`/`ChainGateway`
 * implementation to construct (real Stellar Wallets Kit + Soroban gateway,
 * or the deterministic Playwright stubs) and renders `CheckoutFlow`.
 * `NEXT_PUBLIC_E2E_STUBS` is only ever set by `playwright.config.ts`'s own
 * dev server invocation for the happy-path test — never in a real
 * deployment (see `lib/test-stubs.ts`'s module doc for the full reasoning).
 */
import { useMemo } from "react";
import type { Networks } from "@creit.tech/stellar-wallets-kit";
import { CheckoutFlow } from "./checkout-flow";
import { createStellarChainGateway } from "@/lib/chain-gateway";
import { createStellarWalletAdapter } from "@/lib/wallet";
import { createStubChainGateway, createStubWalletAdapter } from "@/lib/test-stubs";
import { createSystemE2EWalletAdapter } from "@/lib/system-e2e-wallet";
import type { PublicCheckoutSession } from "@/lib/api";
// Type-only import: erased at compile time, so this never pulls the real
// module (which touches `node:fs` to load `deployments/<network>.json`)
// into the client bundle. `deployment` itself is provided as a plain,
// already-loaded object by the Server Component parent.
import type { DeploymentRecord } from "@paymap/contract-client";

export interface CheckoutPageClientProps {
  session: PublicCheckoutSession;
  deployment: DeploymentRecord;
  nowUnixSeconds: string;
}

const USE_STUBS = process.env.NEXT_PUBLIC_E2E_STUBS === "1";
const SYSTEM_E2E_SIGNER_URL = process.env.NEXT_PUBLIC_SYSTEM_E2E_SIGNER_URL;

export function CheckoutPageClient({
  session,
  deployment,
  nowUnixSeconds,
}: CheckoutPageClientProps) {
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
    () => (USE_STUBS ? createStubChainGateway() : createStellarChainGateway(deployment)),
    [deployment],
  );

  return (
    <CheckoutFlow
      session={session}
      wallet={wallet}
      gateway={gateway}
      mandateContractId={deployment.contractId}
      nowUnixSeconds={BigInt(nowUnixSeconds)}
    />
  );
}
