import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateMerchantForm } from "./create-merchant-form";
import { createMerchantAction } from "@/lib/merchant-actions";

vi.mock("@/lib/merchant-actions", () => ({
  createMerchantAction: vi.fn(),
}));

const mockedAction = vi.mocked(createMerchantAction);

describe("CreateMerchantForm — API key shown exactly once, never re-displayed", () => {
  it("does not render any key value before submission", () => {
    render(<CreateMerchantForm />);
    expect(screen.queryByTestId("new-api-key-value")).not.toBeInTheDocument();
    expect(screen.getByTestId("create-merchant-form")).toBeInTheDocument();
  });

  it("shows the freshly issued key exactly once after a successful submission", async () => {
    mockedAction.mockResolvedValue({
      ok: true,
      result: { merchantId: "merchant-1", name: "Acme", walletAddress: "GACME", apiKeyId: "key-1", apiKey: "pmk_live_only_shown_once" },
    });
    const user = userEvent.setup();
    render(<CreateMerchantForm />);

    await user.type(screen.getByTestId("create-merchant-name-input"), "Acme");
    await user.type(screen.getByTestId("create-merchant-wallet-input"), "GACME");
    await user.click(screen.getByTestId("create-merchant-submit-button"));

    const keyElement = await screen.findByTestId("new-api-key-value");
    expect(keyElement).toHaveTextContent("pmk_live_only_shown_once");

    // Exactly one occurrence of the secret anywhere in the rendered output —
    // not echoed a second time into some other element (e.g. a hidden field,
    // a duplicated confirmation banner).
    const occurrences = document.body.innerHTML.split("pmk_live_only_shown_once").length - 1;
    expect(occurrences).toBe(1);

    // The success view replaces the create form entirely — there is no
    // lingering form still submittable to "fetch" the key again.
    expect(screen.queryByTestId("create-merchant-form")).not.toBeInTheDocument();
    expect(mockedAction).toHaveBeenCalledTimes(1);
  });

  it("shows a server-returned error without ever fabricating a key", async () => {
    mockedAction.mockResolvedValue({ ok: false, error: "That wallet address is invalid." });
    const user = userEvent.setup();
    render(<CreateMerchantForm />);

    await user.type(screen.getByTestId("create-merchant-name-input"), "Acme");
    await user.type(screen.getByTestId("create-merchant-wallet-input"), "not-a-real-address");
    await user.click(screen.getByTestId("create-merchant-submit-button"));

    expect(await screen.findByTestId("create-merchant-error")).toHaveTextContent("That wallet address is invalid.");
    expect(screen.queryByTestId("new-api-key-value")).not.toBeInTheDocument();
  });
});
