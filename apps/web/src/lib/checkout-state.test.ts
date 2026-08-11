import { describe, expect, it } from "vitest";
import { checkoutReducer, initialCheckoutState, type CheckoutState } from "./checkout-state";
import type { DisplayError } from "./errors";

const fakeError: DisplayError = { message: "boom", code: "TEST_ERROR", retryable: true };

describe("checkoutReducer", () => {
  it("walks the full happy path: connect -> create -> approve -> link -> complete", () => {
    let state = initialCheckoutState;
    state = checkoutReducer(state, { type: "CONNECT_START" });
    expect(state.phase).toBe("connecting");

    state = checkoutReducer(state, { type: "CONNECT_SUCCESS", address: "GPAYER" });
    expect(state).toEqual({ phase: "ready", address: "GPAYER" });

    state = checkoutReducer(state, { type: "CREATE_MANDATE_START" });
    expect(state.phase).toBe("creating-mandate");

    state = checkoutReducer(state, { type: "CREATE_MANDATE_SUCCESS", mandateId: "mandate-1" });
    expect(state).toMatchObject({ phase: "approving", address: "GPAYER", mandateId: "mandate-1" });

    state = checkoutReducer(state, { type: "APPROVE_SUCCESS" });
    expect(state.phase).toBe("linking");

    state = checkoutReducer(state, { type: "LINK_SUCCESS" });
    expect(state).toMatchObject({ phase: "complete", mandateId: "mandate-1" });
    expect(state.linkWarning).toBeUndefined();
  });

  it("the critical case: an approve failure after mandate creation preserves mandateId instead of stranding the payer", () => {
    let state: CheckoutState = { phase: "approving", address: "GPAYER", mandateId: "mandate-1" };
    state = checkoutReducer(state, { type: "APPROVE_ERROR", error: fakeError });
    expect(state).toMatchObject({ phase: "error", failedStep: "approve", mandateId: "mandate-1", address: "GPAYER" });
    // The UI reads mandateId directly off the error state to render "created but not funded yet" + a retry action.
    expect(state.mandateId).toBe("mandate-1");
  });

  it("retrying approve after a failure clears the previous error but keeps mandateId", () => {
    let state: CheckoutState = { phase: "error", failedStep: "approve", mandateId: "mandate-1", address: "GPAYER", error: fakeError };
    state = checkoutReducer(state, { type: "APPROVE_START" });
    expect(state).toEqual({ phase: "approving", mandateId: "mandate-1", address: "GPAYER" });
    expect(state.error).toBeUndefined();
  });

  it("a create-mandate failure never sets a mandateId", () => {
    let state: CheckoutState = { phase: "creating-mandate", address: "GPAYER" };
    state = checkoutReducer(state, { type: "CREATE_MANDATE_ERROR", error: fakeError });
    expect(state.mandateId).toBeUndefined();
    expect(state).toMatchObject({ phase: "error", failedStep: "create-mandate" });
  });

  it("a link failure after a successful approve is a non-blocking warning, not a hard error (the mandate is already funded on-chain)", () => {
    let state: CheckoutState = { phase: "linking", address: "GPAYER", mandateId: "mandate-1" };
    state = checkoutReducer(state, { type: "LINK_ERROR", error: fakeError });
    expect(state.phase).toBe("complete");
    expect(state.linkWarning).toEqual(fakeError);
    expect(state.error).toBeUndefined();
  });

  it("a connect failure never carries a stale address forward", () => {
    let state: CheckoutState = { phase: "connecting" };
    state = checkoutReducer(state, { type: "CONNECT_ERROR", error: fakeError });
    expect(state).toEqual({ phase: "error", failedStep: "connect", error: fakeError });
  });
});
