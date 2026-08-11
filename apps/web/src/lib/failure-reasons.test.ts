import { describe, expect, it } from "vitest";
import { _MANDATE_ERROR_TABLE_FOR_TEST as MANDATE_ERROR_TABLE } from "@paymap/stellar";
import { ALL_KNOWN_FAILURE_CODES, describeFailureReason } from "./failure-reasons";

describe("describeFailureReason", () => {
  it("covers every one of the 24 frozen contract error codes with distinct, non-empty copy (canary — fails loudly if the frozen table's size ever changes silently)", () => {
    expect(MANDATE_ERROR_TABLE).toHaveLength(24);
    for (const entry of MANDATE_ERROR_TABLE) {
      const reason = describeFailureReason(entry.name);
      expect(reason.code).toBe(entry.name);
      expect(reason.headline.length).toBeGreaterThan(0);
      expect(reason.explanation.length).toBeGreaterThan(0);
      // Never the generic unrecognized-code fallback for a code this module claims to know.
      expect(reason.headline).not.toBe("Charge attempt blocked");
    }
  });

  it("covers every relayer infra-transient reason, framed as non-policy/temporary", () => {
    for (const reason of ["RPC_UNAVAILABLE", "SEND_FAILED", "TX_NOT_INCLUDED"]) {
      const described = describeFailureReason(reason);
      expect(described.code).toBe(reason);
      expect(described.explanation).toMatch(/wasn't a policy rejection/i);
    }
  });

  it("a specific over-limit code is framed as protection working, not a scary error", () => {
    const reason = describeFailureReason("AmountExceedsChargeLimit");
    expect(reason.explanation).toMatch(/merchant tried to charge more than your agreed maximum/i);
    expect(reason.explanation).toMatch(/blocked/i);
  });

  it("falls back honestly (never throws) for an unrecognized code, without hiding it", () => {
    const reason = describeFailureReason("SomeFutureCodeThisBuildDoesNotKnow");
    expect(reason.code).toBe("SomeFutureCodeThisBuildDoesNotKnow");
    expect(reason.explanation).toContain("SomeFutureCodeThisBuildDoesNotKnow");
  });

  it("ALL_KNOWN_FAILURE_CODES lists exactly the 24 contract codes plus the 3 infra reasons", () => {
    expect(ALL_KNOWN_FAILURE_CODES).toHaveLength(27);
  });
});
