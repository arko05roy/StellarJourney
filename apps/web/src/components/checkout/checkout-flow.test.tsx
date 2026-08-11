import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckoutFlow } from "./checkout-flow";
import type * as ApiModule from "@/lib/api";
import type { PublicCheckoutSession } from "@/lib/api";
import type { WalletAdapter } from "@/lib/wallet";
import type { ChainGateway } from "@/lib/chain-gateway";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, linkMandateToCheckoutSession: vi.fn().mockResolvedValue({}) };
});

const SESSION: PublicCheckoutSession = {
  id: "session-1",
  status: "pending",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  merchant: { name: "Acme Studio", walletAddress: "GMERCHANT" },
  product: {
    id: "prod-1",
    name: "Pro Plan",
    assetAddress: `C${"A".repeat(55)}`,
    assetDecimals: 7,
    amountType: "fixed",
    fixedAmount: "15.00",
    maxPerPeriod: "15.00",
    periodSeconds: 2_592_000,
    minIntervalSeconds: 0,
    maxSuccessfulCharges: 12,
    defaultDurationSeconds: 31_536_000,
    active: true,
    createdAt: new Date().toISOString(),
  },
};

function fakeWallet(): WalletAdapter {
  return {
    connect: vi.fn().mockResolvedValue({ address: "GPAYER" }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
  };
}

describe("CheckoutFlow — allowance-change safety sequence", () => {
  it("zeroes an existing non-zero allowance, confirms it, then sets the new amount (PLAN.md §10.10)", async () => {
    const user = userEvent.setup();
    const approveCalls: bigint[] = [];
    let allowance = 500_000_000n; // payer already has a leftover approval from an earlier mandate

    const gateway: ChainGateway = {
      createMandate: vi.fn().mockResolvedValue({ mandateId: "a".repeat(64) }),
      approve: vi.fn(async (args) => {
        approveCalls.push(args.amount);
        allowance = args.amount;
      }),
      queryAllowance: vi.fn(async () => allowance),
    };

    render(
      <CheckoutFlow session={SESSION} wallet={fakeWallet()} gateway={gateway} mandateContractId="CMANDATECONTRACT" nowUnixSeconds={1_800_000_000n} />,
    );

    await user.click(screen.getByTestId("connect-wallet-button"));
    await waitFor(() => expect(screen.getByTestId("authorize-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("authorize-button"));

    await waitFor(() => expect(approveCalls.length).toBeGreaterThanOrEqual(2));

    // First call must zero the previous allowance; only then does the second call set the new bounded amount.
    expect(approveCalls[0]).toBe(0n);
    expect(approveCalls[1]).toBeGreaterThan(0n);
    expect(gateway.queryAllowance).toHaveBeenCalled();
  });

  it("skips the zero-out step entirely when there is no prior allowance (the common first-mandate case)", async () => {
    const user = userEvent.setup();
    const approveCalls: bigint[] = [];

    const gateway: ChainGateway = {
      createMandate: vi.fn().mockResolvedValue({ mandateId: "b".repeat(64) }),
      approve: vi.fn(async (args) => {
        approveCalls.push(args.amount);
      }),
      queryAllowance: vi.fn().mockResolvedValue(0n),
    };

    render(
      <CheckoutFlow session={SESSION} wallet={fakeWallet()} gateway={gateway} mandateContractId="CMANDATECONTRACT" nowUnixSeconds={1_800_000_000n} />,
    );

    await user.click(screen.getByTestId("connect-wallet-button"));
    await waitFor(() => expect(screen.getByTestId("authorize-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("authorize-button"));

    await waitFor(() => expect(approveCalls.length).toBe(1));
    expect(approveCalls[0]).toBeGreaterThan(0n);
  });
});
