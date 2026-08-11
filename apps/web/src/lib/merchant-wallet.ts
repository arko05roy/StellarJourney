"use client";

import { getNetworkDetails, isConnected, requestAccess, signMessage } from "@stellar/freighter-api";

export interface MerchantWalletAdapter {
  connect(): Promise<{ address: string }>;
  signMessage(
    message: string,
    options: { networkPassphrase: string; address: string },
  ): Promise<{ signature: string; signerAddress: string }>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createFreighterMerchantWalletAdapter(
  expectedNetworkPassphrase: string,
): MerchantWalletAdapter {
  return {
    async connect() {
      const connection = await isConnected();
      if (!connection.isConnected) {
        throw new Error("Install or unlock Freighter to continue.");
      }
      const access = await requestAccess();
      if (access.error || !access.address) {
        throw new Error("Freighter did not grant wallet access.");
      }
      const network = await getNetworkDetails();
      if (network.error || network.networkPassphrase !== expectedNetworkPassphrase) {
        throw new Error("Switch Freighter to the Paymap testnet network and try again.");
      }
      return { address: access.address };
    },
    async signMessage(message, options) {
      const result = await signMessage(message, {
        address: options.address,
        networkPassphrase: options.networkPassphrase,
      });
      if (result.error || !result.signedMessage || !result.signerAddress) {
        throw new Error("Wallet signature was declined or could not be created.");
      }
      return {
        signature:
          typeof result.signedMessage === "string"
            ? result.signedMessage
            : bytesToBase64(result.signedMessage),
        signerAddress: result.signerAddress,
      };
    },
  };
}

export function createStubMerchantWalletAdapter(): MerchantWalletAdapter {
  const address = `G${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`.padEnd(56, "A");
  return {
    connect: async () => ({ address }),
    signMessage: async () => ({
      signature: "e2e-wallet-signature",
      signerAddress: address,
    }),
  };
}
