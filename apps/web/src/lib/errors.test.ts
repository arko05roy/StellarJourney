import { describe, expect, it } from "vitest";
import { decodeMandateErrorName } from "@paymap/stellar";
import { toDisplayError } from "./errors";
import { ApiError } from "./api";

describe("toDisplayError", () => {
  it("maps a known contract error to specific consumer language, preserving the code", () => {
    const contractError = decodeMandateErrorName("MandateRevoked");
    const display = toDisplayError(contractError);
    expect(display.message).toBe("This automatic payment has been cancelled.");
    expect(display.code).toBe("MandateRevoked");
    expect(display.retryable).toBe(false);
  });

  it("marks InsufficientBalance/InsufficientAllowance as retryable, mirroring the relayer's own policy", () => {
    expect(toDisplayError(decodeMandateErrorName("InsufficientAllowance")).retryable).toBe(true);
    expect(toDisplayError(decodeMandateErrorName("InsufficientBalance")).retryable).toBe(true);
  });

  it("maps an ApiError through with its own code and message intact", () => {
    const display = toDisplayError(new ApiError(404, "CHECKOUT_SESSION_NOT_FOUND", "No checkout session."));
    expect(display).toEqual({ message: "No checkout session.", code: "CHECKOUT_SESSION_NOT_FOUND", retryable: false });
  });

  it("classifies a wallet rejection as retryable, never a generic failure", () => {
    const display = toDisplayError(new Error("User rejected the request"));
    expect(display.code).toBe("WALLET_REJECTED");
    expect(display.retryable).toBe(true);
  });

  it("classifies a network failure as retryable", () => {
    const display = toDisplayError(new Error("fetch failed"));
    expect(display.code).toBe("NETWORK_ERROR");
  });

  it("never falls back to a bare generic message for an unrecognized Error", () => {
    const display = toDisplayError(new Error("some totally unexpected failure"));
    expect(display.message).toBe("some totally unexpected failure");
    expect(display.code).toBe("UNKNOWN_ERROR");
  });

  it("handles a non-Error thrown value without crashing", () => {
    expect(toDisplayError("a string was thrown")).toEqual({
      message: "An unexpected error occurred.",
      code: "UNKNOWN_ERROR",
      retryable: false,
    });
  });
});
