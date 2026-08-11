import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrKey } from "@stellar/stellar-sdk";
import { ProductForm } from "./product-form";
import { createProductAction } from "@/lib/merchant-actions";

vi.mock("@/lib/merchant-actions", () => ({
  createProductAction: vi.fn(async () => undefined),
}));

const VALID_ASSET_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 3));

async function fillCommonFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("product-name-input"), "Studio Membership");
  await user.clear(screen.getByTestId("product-asset-address-input"));
  await user.type(screen.getByTestId("product-asset-address-input"), VALID_ASSET_ADDRESS);
  await user.clear(screen.getByTestId("product-max-per-period-input"));
  await user.type(screen.getByTestId("product-max-per-period-input"), "15.00");
}

describe("ProductForm", () => {
  it("renders every required field for the plan/mandate-terms form", () => {
    render(<ProductForm />);
    expect(screen.getByTestId("product-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("product-asset-address-input")).toBeInTheDocument();
    expect(screen.getByTestId("product-asset-decimals-input")).toBeInTheDocument();
    expect(screen.getByTestId("product-amount-type-fixed")).toBeInTheDocument();
    expect(screen.getByTestId("product-amount-type-variable")).toBeInTheDocument();
    expect(screen.getByTestId("product-max-per-period-input")).toBeInTheDocument();
    expect(screen.getByTestId("product-period-seconds-input")).toBeInTheDocument();
    expect(screen.getByLabelText(/minimum interval/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/maximum number of charges/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mandate lifetime/i)).toBeInTheDocument();
  });

  it("shows the fixed-amount field by default, and switches to the max-per-charge field for variable", async () => {
    const user = userEvent.setup();
    render(<ProductForm />);
    expect(screen.getByTestId("product-fixed-amount-input")).toBeInTheDocument();
    expect(screen.queryByTestId("product-max-per-charge-input")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("product-amount-type-variable"));

    expect(screen.queryByTestId("product-fixed-amount-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("product-max-per-charge-input")).toBeInTheDocument();
  });

  it("blocks submission and shows a field error for over-precision amounts, without calling the server action", async () => {
    const user = userEvent.setup();
    render(<ProductForm />);
    await fillCommonFields(user);

    await user.clear(screen.getByTestId("product-asset-decimals-input"));
    await user.type(screen.getByTestId("product-asset-decimals-input"), "2");
    await user.type(screen.getByTestId("product-fixed-amount-input"), "15.123456");

    await user.click(screen.getByTestId("product-form-submit-button"));

    expect(await screen.findByText(/fractional digits/i)).toBeInTheDocument();
    expect(createProductAction).not.toHaveBeenCalled();
  });

  it("submits the server action once client-side validation passes", async () => {
    const user = userEvent.setup();
    render(<ProductForm />);
    await fillCommonFields(user);
    await user.type(screen.getByTestId("product-fixed-amount-input"), "15.00");

    await user.click(screen.getByTestId("product-form-submit-button"));

    await vi.waitFor(() => expect(createProductAction).toHaveBeenCalled());
  });
});
