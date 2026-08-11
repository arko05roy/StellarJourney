/**
 * Wallet connection via Stellar Wallets Kit (the lead's decision — Freighter
 * as the primary wallet, PLAN.md §7). Browser-only: every export here must
 * only ever be called from a Client Component, after the module has loaded
 * in a real `window` environment — `StellarWalletsKit.init` touches
 * `window`/`document` directly.
 *
 * Exposes a small `WalletAdapter` interface rather than the kit's static
 * class directly, so `components/checkout/checkout-flow.tsx` can accept an
 * injected stub adapter for the Playwright happy-path test (no real wallet
 * extension in CI) without the production code path knowing tests exist.
 */
import { StellarWalletsKit, type Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";

export interface WalletAdapter {
  /** Opens the wallet-selection modal and returns the connected address. */
  connect(): Promise<{ address: string }>;
  disconnect(): Promise<void>;
  signTransaction: SignTransaction;
  signAuthEntry: SignAuthEntry;
}

let initialized = false;

function ensureInitialized(networkPassphrase: Networks): void {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: [new FreighterModule(), new xBullModule()],
    network: networkPassphrase,
    authModal: { showInstallLabel: true },
  });
  initialized = true;
}

/** Real, production `WalletAdapter` backed by Stellar Wallets Kit. */
export function createStellarWalletAdapter(networkPassphrase: Networks): WalletAdapter {
  ensureInitialized(networkPassphrase);
  return {
    connect: () => StellarWalletsKit.authModal(),
    disconnect: () => StellarWalletsKit.disconnect(),
    signTransaction: (xdr, opts) => StellarWalletsKit.signTransaction(xdr, opts),
    signAuthEntry: (authEntry, opts) => StellarWalletsKit.signAuthEntry(authEntry, opts),
  };
}
