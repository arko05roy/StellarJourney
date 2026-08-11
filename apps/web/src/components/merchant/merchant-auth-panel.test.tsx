import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MerchantAuthPanel } from "./merchant-auth-panel";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  signMessage: vi.fn(),
  createChallenge: vi.fn(),
  completeAuth: vi.fn(),
  registerProfile: vi.fn(),
}));

vi.mock("@/lib/merchant-wallet", () => ({
  createFreighterMerchantWalletAdapter: () => ({
    connect: mocks.connect,
    signMessage: mocks.signMessage,
  }),
  createStubMerchantWalletAdapter: () => ({
    connect: mocks.connect,
    signMessage: mocks.signMessage,
  }),
}));

vi.mock("@/lib/merchant-actions", () => ({
  createMerchantChallengeAction: mocks.createChallenge,
  completeMerchantAuthAction: mocks.completeAuth,
  registerMerchantProfileAction: mocks.registerProfile,
}));

describe("MerchantAuthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ address: "GMERCHANT" });
    mocks.signMessage.mockResolvedValue({
      signature: "signature",
      signerAddress: "GMERCHANT",
    });
    mocks.createChallenge.mockResolvedValue({
      ok: true,
      challenge: {
        challengeId: "challenge",
        message: "Sign in",
        networkPassphrase: "Test Network",
        expiresAt: "2026-01-01T00:05:00.000Z",
      },
    });
    mocks.completeAuth.mockResolvedValue({
      ok: true,
      profileRequired: true,
      walletAddress: "GMERCHANT",
    });
  });

  it("connects, signs the exact challenge, then asks a new merchant for a business name", async () => {
    const user = userEvent.setup();
    render(<MerchantAuthPanel networkPassphrase="Test Network" />);
    await user.click(screen.getByTestId("merchant-wallet-connect-button"));

    expect(await screen.findByTestId("merchant-profile-step")).toBeInTheDocument();
    expect(mocks.signMessage).toHaveBeenCalledWith("Sign in", {
      address: "GMERCHANT",
      networkPassphrase: "Test Network",
    });
    expect(mocks.completeAuth).toHaveBeenCalledWith({
      challengeId: "challenge",
      message: "Sign in",
      signature: "signature",
      signerAddress: "GMERCHANT",
    });
    expect(screen.getByTestId("merchant-profile-name-input")).toBeRequired();
  });

  it("shows wallet failures without exposing a manual address or API-key input", async () => {
    mocks.connect.mockRejectedValue(new Error("Install or unlock Freighter to continue."));
    const user = userEvent.setup();
    render(<MerchantAuthPanel networkPassphrase="Test Network" />);
    await user.click(screen.getByTestId("merchant-wallet-connect-button"));

    expect(await screen.findByTestId("merchant-auth-error")).toHaveTextContent(
      "Install or unlock Freighter",
    );
    expect(screen.queryByLabelText(/wallet address/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });
});
