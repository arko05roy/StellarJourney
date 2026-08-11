/**
 * Phase 13's opt-in browser signer adapter.
 *
 * The Playwright system harness generates an ephemeral testnet identity at
 * runtime and keeps its secret in the test runner's memory. This adapter
 * receives only a loopback signing URL; no secret enters source, Next env,
 * browser storage, browser logs, or Playwright output.
 *
 * Never use this in a deployment. The factory rejects non-loopback URLs and
 * both client boundaries require an explicit `NEXT_PUBLIC_SYSTEM_E2E_SIGNER_URL`.
 */
import type { WalletAdapter } from "./wallet";

interface SignTransactionResponse {
  signedTxXdr: string;
  signerAddress?: string;
}

interface SignAuthEntryResponse {
  signedAuthEntry: string;
  signerAddress?: string;
}

function assertLoopbackSignerUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("system E2E signer must use an http:// loopback URL");
  }
  return url.toString().replace(/\/$/, "");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`system E2E signer returned ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}

/** Test-only wallet whose secret remains inside the local Playwright harness. */
export function createSystemE2EWalletAdapter(rawSignerUrl: string): WalletAdapter {
  const signerUrl = assertLoopbackSignerUrl(rawSignerUrl);

  return {
    async connect() {
      const response = await fetch(`${signerUrl}/public-key`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`system E2E signer returned ${String(response.status)}`);
      }
      const body = (await response.json()) as { publicKey?: unknown };
      if (typeof body.publicKey !== "string") {
        throw new Error("system E2E signer returned an invalid public key");
      }
      return { address: body.publicKey };
    },
    disconnect: async () => undefined,
    signTransaction: (xdr, opts) =>
      postJson<SignTransactionResponse>(`${signerUrl}/sign-transaction`, {
        xdr,
        networkPassphrase: opts?.networkPassphrase,
      }),
    signAuthEntry: (authEntry, opts) =>
      postJson<SignAuthEntryResponse>(`${signerUrl}/sign-auth-entry`, {
        authEntry,
        networkPassphrase: opts?.networkPassphrase,
        address: opts?.address,
      }),
  };
}
