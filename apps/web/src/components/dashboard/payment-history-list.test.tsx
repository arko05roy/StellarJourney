import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentHistoryList } from "./payment-history-list";

const PAYMENT = {
  paymentId: "payment-1",
  mandateId: "mandate-1",
  chargeId: "charge-1",
  merchant: { name: "CloudBox", walletAddress: "GMERCHANT" },
  amount: "145000000",
  assetAddress: `C${"A".repeat(55)}`,
  transactionHash: "a".repeat(64),
  createdAt: "2026-07-29T10:00:00.000Z",
};

const BLOCKED = {
  id: "attempt-1",
  mandateId: "mandate-1",
  chargeId: "charge-2",
  merchant: { name: "CloudBox", walletAddress: "GMERCHANT" },
  amount: "250000000",
  status: "permanently_failed",
  failureCode: "AmountExceedsChargeLimit",
  attemptedAt: "2026-07-29T11:00:00.000Z",
};

describe("PaymentHistoryList transaction timeline", () => {
  it("orders all activity newest first and links settled transactions to the configured network", () => {
    render(
      <PaymentHistoryList
        payments={[PAYMENT]}
        failedAttempts={[BLOCKED]}
        network="testnet"
        assetDecimalsFor={() => 7}
      />,
    );

    const timeline = screen.getByTestId("transaction-timeline");
    const rows = within(timeline).getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-testid", "payment-history-failed-row");
    expect(rows[1]).toHaveAttribute("data-testid", "payment-history-success-row");
    expect(within(timeline).getByRole("link", { name: /view transaction/i })).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/tx/${PAYMENT.transactionHash}`,
    );
  });

  it("renders an empty state when no ledger activity exists", () => {
    render(
      <PaymentHistoryList
        payments={[]}
        failedAttempts={[]}
        network="testnet"
        assetDecimalsFor={() => 7}
      />,
    );
    expect(screen.getByTestId("payment-history-empty")).toHaveTextContent("No payments yet");
  });
});
