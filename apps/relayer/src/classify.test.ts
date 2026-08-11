import { describe, expect, it } from "vitest";
import {
  ALL_CONTRACT_ERROR_NAMES,
  classifyContractErrorName,
  classifyInfraFailure,
  INFRA_TRANSIENT_REASONS,
  UnclassifiableContractError,
} from "./classify.js";

// The frozen permanent/transient split (CLAUDE.md §11, decision #5): every
// code is permanent except the two that are transient "subject to merchant
// retry policy" — insufficient allowance/balance. This mirrors
// `packages/stellar/src/errors.ts`'s own `retryable` flag exactly (this
// classifier consumes it, never re-derives it).
const EXPECTED_TRANSIENT = new Set(["InsufficientAllowance", "InsufficientBalance"]);

describe("classifyContractErrorName — one assertion per frozen contract error code", () => {
  it("covers all 24 frozen codes (canary — fails loudly if the frozen table's size ever changes silently)", () => {
    expect(ALL_CONTRACT_ERROR_NAMES).toHaveLength(24);
  });

  for (const name of [
    "MandateNotFound",
    "MandateNotActive",
    "MandatePaused",
    "MandateRevoked",
    "MandateCompleted",
    "MandateExpired",
    "ChargeBeforeStart",
    "ChargeTooSoon",
    "InvalidAmount",
    "AmountExceedsChargeLimit",
    "AmountExceedsPeriodLimit",
    "ChargeCountExceeded",
    "DuplicateCharge",
    "UnauthorizedMerchant",
    "InsufficientAllowance",
    "InsufficientBalance",
    "PaymentNotFound",
    "RefundExceedsPayment",
    "DuplicateRefund",
    "ArithmeticOverflow",
    "InvalidMandateInput",
    "DuplicateMandate",
    "InvalidStateTransition",
    "RefundNotFound",
  ] as const) {
    const expectedClass = EXPECTED_TRANSIENT.has(name) ? "transient" : "permanent";
    it(`classifies "${name}" as "${expectedClass}"`, () => {
      const result = classifyContractErrorName(name);
      expect(result.failureClass).toBe(expectedClass);
      expect(result.reason).toBe(name);
    });
  }

  it("every name in ALL_CONTRACT_ERROR_NAMES is classifiable without throwing (exhaustive, not just the 24 spelled out above)", () => {
    for (const name of ALL_CONTRACT_ERROR_NAMES) {
      expect(() => classifyContractErrorName(name)).not.toThrow();
    }
  });

  it("an unmapped code fails loudly instead of silently defaulting to a retry", () => {
    expect(() => classifyContractErrorName("SomeFutureContractErrorNotInThisBuild")).toThrow(UnclassifiableContractError);
  });
});

describe("classifyInfraFailure", () => {
  for (const reason of INFRA_TRANSIENT_REASONS) {
    it(`classifies "${reason}" as transient`, () => {
      expect(classifyInfraFailure(reason)).toEqual({ failureClass: "transient", reason });
    });
  }
});
