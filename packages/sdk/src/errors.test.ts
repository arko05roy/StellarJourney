/**
 * Drift check only (CLAUDE.md §20) — `@paymap/stellar` is a devDependency
 * of this package used *only* here, never shipped in the built SDK. If
 * `contracts/mandate-registry/src/error.rs` ever gains/loses/renames a
 * code, `packages/stellar/src/errors.test.ts` catches the drift against the
 * Rust source directly, and this test catches this package's own literal
 * list drifting from `@paymap/stellar`'s.
 */
import { describe, expect, it } from "vitest";
import { _MANDATE_ERROR_TABLE_FOR_TEST } from "@paymap/stellar";
import { MANDATE_CONTRACT_ERROR_CODES, StellarMandatesApiError } from "./errors.js";

describe("MANDATE_CONTRACT_ERROR_CODES drift check", () => {
  it("matches @paymap/stellar's frozen table exactly (same 24 names, same order)", () => {
    const expected = _MANDATE_ERROR_TABLE_FOR_TEST.map((entry) => entry.name);
    expect(MANDATE_CONTRACT_ERROR_CODES).toEqual(expected);
  });

  it("has exactly 24 entries (canary — fails loudly if either list's size changes silently)", () => {
    expect(MANDATE_CONTRACT_ERROR_CODES).toHaveLength(24);
  });
});

describe("StellarMandatesApiError", () => {
  it("preserves code/httpStatus/message/details verbatim", () => {
    const error = new StellarMandatesApiError(409, "MandateRevoked", "Contract rejected the request: MandateRevoked.", { foo: "bar" });
    expect(error.code).toBe("MandateRevoked");
    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe("Contract rejected the request: MandateRevoked.");
    expect(error.details).toEqual({ foo: "bar" });
    expect(error).toBeInstanceOf(Error);
  });

  it("isContractError() narrows for a frozen contract code", () => {
    const error = new StellarMandatesApiError(409, "MandateRevoked", "revoked");
    expect(error.isContractError()).toBe(true);
  });

  it("isContractError() is false for a non-contract API code", () => {
    const error = new StellarMandatesApiError(400, "VALIDATION_ERROR", "bad input");
    expect(error.isContractError()).toBe(false);
  });
});
