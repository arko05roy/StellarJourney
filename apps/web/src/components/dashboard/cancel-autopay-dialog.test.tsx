import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CancelAutopayDialog } from "./cancel-autopay-dialog";
import type { MandateGateway, MandateSigner } from "@/lib/mandate-gateway";

const SIGNER: MandateSigner = { publicKey: "GPAYER", signTransaction: vi.fn(), signAuthEntry: vi.fn() };

function gatewayWithAllowance(allowance: bigint): MandateGateway {
  return {
    getMandate: vi.fn(),
    pauseMandate: vi.fn(),
    resumeMandate: vi.fn(),
    revokeMandate: vi.fn().mockResolvedValue(undefined),
    queryAllowance: vi.fn().mockResolvedValue(allowance),
    approve: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CancelAutopayDialog — revoke triggers the allowance-zero prompt", () => {
  it("after a successful revoke with a non-zero existing allowance, prompts to set it to zero", async () => {
    const user = userEvent.setup();
    const gateway = gatewayWithAllowance(500_000_000n);
    const onRevoked = vi.fn();

    render(
      <CancelAutopayDialog
        mandateId={"a".repeat(64)}
        tokenContractId={`C${"A".repeat(55)}`}
        mandateExpiresAt={2_000_000_000n}
        assetSymbol="PUSD"
        mandateContractId={`C${"B".repeat(55)}`}
        gateway={gateway}
        signer={SIGNER}
        onClose={vi.fn()}
        onRevoked={onRevoked}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("confirm-cancel-autopay-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("confirm-cancel-autopay-button"));

    await waitFor(() => expect(gateway.revokeMandate).toHaveBeenCalled());
    expect(onRevoked).toHaveBeenCalledWith("a".repeat(64));

    await waitFor(() => expect(screen.getByTestId("set-allowance-zero-button")).toBeInTheDocument());
    expect(screen.getByText(/set your spending approval to zero/i)).toBeInTheDocument();

    await user.click(screen.getByTestId("set-allowance-zero-button"));
    await waitFor(() => expect(gateway.approve).toHaveBeenCalledWith(expect.objectContaining({ amount: 0n }), SIGNER));
    await waitFor(() => expect(screen.getByTestId("close-cancel-autopay-dialog-button")).toBeInTheDocument());
  });

  it("skips the allowance prompt entirely when the allowance is already zero", async () => {
    const user = userEvent.setup();
    const gateway = gatewayWithAllowance(0n);

    render(
      <CancelAutopayDialog
        mandateId={"a".repeat(64)}
        tokenContractId={`C${"A".repeat(55)}`}
        mandateExpiresAt={2_000_000_000n}
        assetSymbol="PUSD"
        mandateContractId={`C${"B".repeat(55)}`}
        gateway={gateway}
        signer={SIGNER}
        onClose={vi.fn()}
        onRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("confirm-cancel-autopay-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("confirm-cancel-autopay-button"));

    await waitFor(() => expect(screen.getByTestId("close-cancel-autopay-dialog-button")).toBeInTheDocument());
    expect(screen.queryByTestId("set-allowance-zero-button")).not.toBeInTheDocument();
    expect(gateway.approve).not.toHaveBeenCalled();
  });

  it("declining the prompt (Skip for now) still reaches the completed summary", async () => {
    const user = userEvent.setup();
    const gateway = gatewayWithAllowance(500_000_000n);

    render(
      <CancelAutopayDialog
        mandateId={"a".repeat(64)}
        tokenContractId={`C${"A".repeat(55)}`}
        mandateExpiresAt={2_000_000_000n}
        assetSymbol="PUSD"
        mandateContractId={`C${"B".repeat(55)}`}
        gateway={gateway}
        signer={SIGNER}
        onClose={vi.fn()}
        onRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("confirm-cancel-autopay-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("confirm-cancel-autopay-button"));
    await waitFor(() => expect(screen.getByTestId("skip-allowance-zero-button")).toBeInTheDocument());
    await user.click(screen.getByTestId("skip-allowance-zero-button"));

    await waitFor(() => expect(screen.getByTestId("close-cancel-autopay-dialog-button")).toBeInTheDocument());
    expect(gateway.approve).not.toHaveBeenCalled();
  });
});
