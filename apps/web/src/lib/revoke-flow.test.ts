import { describe, expect, it } from "vitest";
import { initialRevokeFlowState, revokeFlowReducer, type RevokeFlowState } from "./revoke-flow";

const FAKE_ERROR = { message: "boom", code: "TEST", retryable: false };

function run(actions: Parameters<typeof revokeFlowReducer>[1][]): RevokeFlowState {
  return actions.reduce(revokeFlowReducer, initialRevokeFlowState);
}

describe("revokeFlowReducer", () => {
  it("revoke success leads to an allowance check, then the prompt when allowance > 0", () => {
    const state = run([
      { type: "OPEN_CONFIRM" },
      { type: "CONFIRM_REVOKE" },
      { type: "REVOKE_SUCCESS" },
      { type: "CHECK_ALLOWANCE_RESULT", allowance: 500_000n },
    ]);
    expect(state.phase).toBe("allowance-prompt");
  });

  it("skips the prompt entirely when the allowance is already zero", () => {
    const state = run([
      { type: "OPEN_CONFIRM" },
      { type: "CONFIRM_REVOKE" },
      { type: "REVOKE_SUCCESS" },
      { type: "CHECK_ALLOWANCE_RESULT", allowance: 0n },
    ]);
    expect(state).toEqual({ phase: "complete", allowanceWasAlreadyZero: true });
  });

  it("zeroing the allowance after the prompt reaches complete", () => {
    const state = run([
      { type: "OPEN_CONFIRM" },
      { type: "CONFIRM_REVOKE" },
      { type: "REVOKE_SUCCESS" },
      { type: "CHECK_ALLOWANCE_RESULT", allowance: 500_000n },
      { type: "CONFIRM_ZERO_ALLOWANCE" },
      { type: "ZERO_ALLOWANCE_SUCCESS" },
    ]);
    expect(state.phase).toBe("complete");
    expect(state.allowanceWasAlreadyZero).toBeUndefined();
  });

  it("declining the prompt (SKIP_ALLOWANCE) still reaches complete — the mandate is already cancelled", () => {
    const state = run([
      { type: "OPEN_CONFIRM" },
      { type: "CONFIRM_REVOKE" },
      { type: "REVOKE_SUCCESS" },
      { type: "CHECK_ALLOWANCE_RESULT", allowance: 500_000n },
      { type: "SKIP_ALLOWANCE" },
    ]);
    expect(state.phase).toBe("complete");
  });

  it("a revoke failure surfaces as revoke-error and never silently proceeds to the allowance step", () => {
    const state = run([{ type: "OPEN_CONFIRM" }, { type: "CONFIRM_REVOKE" }, { type: "REVOKE_ERROR", error: FAKE_ERROR }]);
    expect(state).toEqual({ phase: "revoke-error", error: FAKE_ERROR });
  });

  it("a zero-allowance failure surfaces distinctly, after revoke already succeeded", () => {
    const state = run([
      { type: "OPEN_CONFIRM" },
      { type: "CONFIRM_REVOKE" },
      { type: "REVOKE_SUCCESS" },
      { type: "CHECK_ALLOWANCE_RESULT", allowance: 500_000n },
      { type: "CONFIRM_ZERO_ALLOWANCE" },
      { type: "ZERO_ALLOWANCE_ERROR", error: FAKE_ERROR },
    ]);
    expect(state).toEqual({ phase: "zero-allowance-error", error: FAKE_ERROR });
  });

  it("CLOSE from confirming returns to idle (backed out before signing anything)", () => {
    const state = run([{ type: "OPEN_CONFIRM" }, { type: "CLOSE" }]);
    expect(state).toEqual({ phase: "idle" });
  });

  it("CLOSE mid-revoke (an in-flight signature) is illegal", () => {
    expect(() => run([{ type: "OPEN_CONFIRM" }, { type: "CONFIRM_REVOKE" }, { type: "CLOSE" }])).toThrow();
  });
});
