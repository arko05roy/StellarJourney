/**
 * Deterministic stand-ins for `WalletAdapter`/`ChainGateway`, used only by
 * the Playwright happy-path test (`e2e/checkout.spec.ts`). Wired in by
 * `app/checkout/[sessionId]/page.tsx` when, and only when,
 * `NEXT_PUBLIC_E2E_STUBS=1` is set — a build-time env var the Playwright
 * config sets for its own dev server invocation only (see
 * `playwright.config.ts`), never set in a real deployment. Production code
 * never imports this module conditionally at runtime; the page decides
 * which adapter to construct at build time via the env check, so this
 * module (and its fake "signing" behavior) is simply absent from a
 * production bundle's reachable code paths in spirit, if not literally
 * tree-shaken.
 */
import type { ChainGateway } from "./chain-gateway";
import type { WalletAdapter } from "./wallet";
import { randomHexId32 } from "./ids";

export const STUB_PAYER_ADDRESS = "GATESTSTUBPAYERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX".slice(0, 56).padEnd(56, "A");

export function createStubWalletAdapter(): WalletAdapter {
  let connected = false;
  return {
    async connect() {
      await delay(150);
      connected = true;
      return { address: STUB_PAYER_ADDRESS };
    },
    async disconnect() {
      connected = false;
    },
    async signTransaction(xdr) {
      await delay(50);
      if (!connected) throw new Error("wallet not connected");
      return { signedTxXdr: xdr, signerAddress: STUB_PAYER_ADDRESS };
    },
    async signAuthEntry(authEntry) {
      await delay(50);
      return { signedAuthEntry: authEntry, signerAddress: STUB_PAYER_ADDRESS };
    },
  };
}

export function createStubChainGateway(): ChainGateway {
  let lastMandateId: string | undefined;
  let allowance = 0n;
  return {
    async createMandate() {
      await delay(200);
      lastMandateId = randomHexId32();
      return { mandateId: lastMandateId };
    },
    async approve({ amount }) {
      await delay(200);
      if (!lastMandateId) throw new Error("createMandate must be called before approve");
      allowance = amount;
    },
    async queryAllowance() {
      return allowance;
    },
  } satisfies ChainGateway;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
