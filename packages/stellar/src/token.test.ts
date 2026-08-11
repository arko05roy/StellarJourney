import { describe, expect, it } from "vitest";
import { computeApprovalLiveUntilLedger } from "./token.js";

describe("computeApprovalLiveUntilLedger", () => {
  it("covers the mandate's remaining lifetime plus a safety buffer", () => {
    const currentLedger = 1_000_000;
    const now = 1_800_000_000n;
    const expiresAt = now + 3_600n; // 1 hour away -> 720 ledgers at 5s/ledger
    const result = computeApprovalLiveUntilLedger(currentLedger, now, expiresAt);
    expect(result).toBeGreaterThan(currentLedger + 720);
    // Safety buffer is 360 ledgers.
    expect(result).toBe(currentLedger + 720 + 360);
  });

  it("never goes below currentLedger + the safety buffer when the mandate already expired", () => {
    const currentLedger = 500_000;
    const now = 1_800_000_000n;
    const expiresAt = now - 100n; // already in the past
    const result = computeApprovalLiveUntilLedger(currentLedger, now, expiresAt);
    expect(result).toBe(currentLedger + 360);
  });

  it("caps at the maximum entry TTL for an extremely long-lived mandate", () => {
    const currentLedger = 1;
    const now = 0n;
    const expiresAt = 999_999_999_999n; // absurdly far in the future
    const result = computeApprovalLiveUntilLedger(currentLedger, now, expiresAt);
    expect(result).toBe(currentLedger + 6_312_000);
  });
});
