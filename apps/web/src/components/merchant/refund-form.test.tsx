import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefundForm } from "./refund-form";
import { createRefundAction } from "@/lib/merchant-actions";

vi.mock("@/lib/merchant-actions", () => ({
  createRefundAction: vi.fn(async () => undefined),
}));

const mockedAction = vi.mocked(createRefundAction);

describe("RefundForm — enforces amount <= remaining refundable", () => {
  it("blocks submission and shows an error for an amount exceeding the remaining refundable total, without calling the server action", async () => {
    const user = userEvent.setup();
    render(<RefundForm paymentId={"a".repeat(64)} decimals={2} remainingBaseUnits="6000" assetSymbol="PUSD" />);

    await user.type(screen.getByTestId("refund-amount-input"), "60.01");
    await user.click(screen.getByTestId("refund-submit-button"));

    expect(await screen.findByTestId("refund-form-error")).toHaveTextContent(/exceeds the remaining/i);
    expect(mockedAction).not.toHaveBeenCalled();
  });

  it("allows an amount at exactly the remaining refundable total and submits", async () => {
    const user = userEvent.setup();
    render(<RefundForm paymentId={"a".repeat(64)} decimals={2} remainingBaseUnits="6000" assetSymbol="PUSD" />);

    await user.type(screen.getByTestId("refund-amount-input"), "60.00");
    await user.click(screen.getByTestId("refund-submit-button"));

    await vi.waitFor(() => expect(mockedAction).toHaveBeenCalledTimes(1));
  });

  it("disables submission entirely when nothing remains refundable", () => {
    render(<RefundForm paymentId={"a".repeat(64)} decimals={2} remainingBaseUnits="0" assetSymbol="PUSD" />);
    expect(screen.getByTestId("refund-submit-button")).toBeDisabled();
  });
});
