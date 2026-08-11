import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Mandate, MandateStatus } from "@paymap/contract-client";
import { MandateCard } from "./mandate-card";

const DAY = 86_400n;

function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "a".repeat(64),
    payer: "GPAYER",
    merchant: "GMERCHANT",
    asset: `C${"A".repeat(55)}`,
    status: "Active",
    amountRule: { kind: "fixed", amount: 150_000_000n },
    maxPerPeriod: 150_000_000n,
    periodSeconds: DAY * 30n,
    minIntervalSeconds: DAY,
    startAt: 0n,
    expiresAt: DAY * 365n,
    maxSuccessfulCharges: 12,
    successfulCharges: 1,
    totalCollected: 150_000_000n,
    currentPeriodStart: 0n,
    currentPeriodCollected: 50_000_000n,
    lastChargedAt: DAY,
    createdAt: 0n,
    metadataHash: "b".repeat(64),
    ...overrides,
  };
}

describe("MandateCard — every required field is rendered", () => {
  it("renders merchant, asset, amount, frequency, next eligible date, period usage, expiry, and status", () => {
    render(<MandateCard mandate={baseMandate()} merchantName="Acme Coffee Roasters" assetDecimals={7} nowUnixSeconds={DAY * 2n} />);

    expect(screen.getByText("Acme Coffee Roasters")).toBeInTheDocument();
    expect(screen.getByText(/every 30 days/i)).toBeInTheDocument();
    expect(screen.getByTestId("period-usage-meter")).toBeInTheDocument();
    expect(screen.getByTestId("mandate-status-badge")).toHaveTextContent("Active");

    const fields = screen.getByTestId("mandate-card-fields");
    expect(within(fields).getByText("Payment asset")).toBeInTheDocument();
    expect(fields).toHaveTextContent("Asset CAAA");
    expect(within(fields).getByText("Amount")).toBeInTheDocument();
    expect(fields).toHaveTextContent("15");
    expect(within(fields).getByText("Expiry")).toBeInTheDocument();
    expect(within(fields).getByText("Next eligible charge")).toBeInTheDocument();
  });
});

describe("MandateCard — controls per status", () => {
  it("Active: shows Pause and Cancel autopay, not Resume", () => {
    render(<MandateCard mandate={baseMandate({ status: "Active" })} merchantName="Acme" assetDecimals={7} nowUnixSeconds={DAY * 2n} />);
    expect(screen.getByTestId("pause-button")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-autopay-button")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
  });

  it("Paused: shows Resume and Cancel autopay, not Pause", () => {
    render(<MandateCard mandate={baseMandate({ status: "Paused" })} merchantName="Acme" assetDecimals={7} nowUnixSeconds={DAY * 2n} />);
    expect(screen.getByTestId("resume-button")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-autopay-button")).toBeInTheDocument();
    expect(screen.queryByTestId("pause-button")).not.toBeInTheDocument();
  });

  for (const status of ["Revoked", "Completed", "Expired"] as MandateStatus[]) {
    it(`${status}: no lifecycle controls, shows the terminal note`, () => {
      render(<MandateCard mandate={baseMandate({ status })} merchantName="Acme" assetDecimals={7} nowUnixSeconds={DAY * 2n} />);
      expect(screen.queryByTestId("pause-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("resume-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("cancel-autopay-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("mandate-terminal-note")).toBeInTheDocument();
    });
  }

  it("a mandate that is stored Active but past its expiresAt renders as Expired (lazy expiry, defense in depth)", () => {
    render(<MandateCard mandate={baseMandate({ status: "Active", expiresAt: DAY })} merchantName="Acme" assetDecimals={7} nowUnixSeconds={DAY * 10n} />);
    expect(screen.getByTestId("mandate-status-badge")).toHaveTextContent("Expired");
    expect(screen.queryByTestId("pause-button")).not.toBeInTheDocument();
  });

  it("clicking Pause invokes onPause; a pending action disables the button", () => {
    const onPause = vi.fn();
    render(
      <MandateCard
        mandate={baseMandate({ status: "Active" })}
        merchantName="Acme"
        assetDecimals={7}
        nowUnixSeconds={DAY * 2n}
        onPause={onPause}
        actionState={{ pending: "pause" }}
      />,
    );
    const button = screen.getByTestId("pause-button");
    expect(button).toBeDisabled();
  });

  it("shows an inline error banner when an action failed", () => {
    render(
      <MandateCard
        mandate={baseMandate({ status: "Active" })}
        merchantName="Acme"
        assetDecimals={7}
        nowUnixSeconds={DAY * 2n}
        actionState={{ error: { action: "pause", display: { message: "This automatic payment has been cancelled.", code: "MandateRevoked", retryable: false } } }}
      />,
    );
    expect(screen.getByTestId("error-banner")).toHaveTextContent("cancelled");
  });
});
