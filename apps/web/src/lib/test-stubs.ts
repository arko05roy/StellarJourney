/**
 * Deterministic stand-ins for `WalletAdapter`/`ChainGateway`/
 * `MandateGateway`, used only by the Playwright happy-path tests
 * (`e2e/checkout.spec.ts`, `e2e/dashboard.spec.ts`). Wired in by
 * `app/checkout/[sessionId]/page.tsx` / `app/dashboard/page.tsx` when, and
 * only when, `NEXT_PUBLIC_E2E_STUBS=1` is set — a build-time env var the
 * Playwright config sets for its own dev server invocation only (see
 * `playwright.config.ts`), never set in a real deployment. Production code
 * never imports this module conditionally at runtime; the page decides
 * which adapter to construct at build time via the env check, so this
 * module (and its fake "signing" behavior) is simply absent from a
 * production bundle's reachable code paths in spirit, if not literally
 * tree-shaken.
 */
import type { ChainGateway } from "./chain-gateway";
import type { WalletAdapter } from "./wallet";
import type { Mandate, MandateGateway } from "./mandate-gateway";
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

/**
 * Stub `MandateGateway` for the dashboard's Playwright/manual-QA path.
 * Seeded with an initial set of mandates keyed by id; `pauseMandate`/
 * `resumeMandate`/`revokeMandate` mutate in place exactly like the real
 * contract's legal-transition table would (an illegal transition throws,
 * matching a real simulation rejection) so the E2E test exercises the same
 * UI branches a real chain response would drive. `queryAllowance`/`approve`
 * share one map keyed by `${publicKey}:${tokenContractId}:${spender}` —
 * enough fidelity for the allowance-to-zero prompt's own assertions without
 * modeling every possible spender. `initialAllowances` seeds this map (same
 * key format) so the dashboard E2E test can exercise the real "payer
 * already approved a bounded allowance at checkout, now cancels and is
 * prompted to zero it" path, not just the already-zero skip path.
 */
export function createStubMandateGateway(initialMandates: readonly Mandate[], initialAllowances: ReadonlyMap<string, bigint> = new Map()): MandateGateway {
  const mandates = new Map(initialMandates.map((m) => [m.id, m]));
  const allowances = new Map(initialAllowances);

  function requireMandate(mandateId: string): Mandate {
    const mandate = mandates.get(mandateId);
    if (!mandate) throw new Error(`MandateNotFound`);
    return mandate;
  }

  return {
    async getMandate(mandateId) {
      await delay(80);
      return requireMandate(mandateId);
    },

    async pauseMandate(mandateId) {
      await delay(150);
      const mandate = requireMandate(mandateId);
      if (mandate.status !== "Active") throw new Error("InvalidStateTransition");
      mandates.set(mandateId, { ...mandate, status: "Paused" });
    },

    async resumeMandate(mandateId) {
      await delay(150);
      const mandate = requireMandate(mandateId);
      if (mandate.status !== "Paused") throw new Error("InvalidStateTransition");
      mandates.set(mandateId, { ...mandate, status: "Active" });
    },

    async revokeMandate(mandateId) {
      await delay(150);
      const mandate = requireMandate(mandateId);
      if (mandate.status !== "Active" && mandate.status !== "Paused") throw new Error("InvalidStateTransition");
      mandates.set(mandateId, { ...mandate, status: "Revoked" });
    },

    async queryAllowance({ tokenContractId, spender }, signer) {
      await delay(80);
      return allowances.get(`${signer.publicKey}:${tokenContractId}:${spender}`) ?? 0n;
    },

    async approve({ tokenContractId, spender, amount }, signer) {
      await delay(150);
      allowances.set(`${signer.publicKey}:${tokenContractId}:${spender}`, amount);
    },
  } satisfies MandateGateway;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
