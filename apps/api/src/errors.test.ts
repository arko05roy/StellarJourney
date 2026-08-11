import { describe, expect, it } from "vitest";
import { decodeMandateErrorCode, _MANDATE_ERROR_TABLE_FOR_TEST } from "@paymap/stellar";
import { mandateErrorToApiError } from "./errors.js";

describe("mandateErrorToApiError", () => {
  it("preserves the original contract error name as the API `code` for every frozen error", () => {
    for (const entry of _MANDATE_ERROR_TABLE_FOR_TEST) {
      const decoded = decodeMandateErrorCode(entry.code);
      const apiError = mandateErrorToApiError(decoded);
      expect(apiError.code).toBe(entry.name);
      expect(apiError.code).not.toBe("INTERNAL_ERROR");
      expect(apiError.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });

  it("never falls back to a generic 500 for a recognized contract error", () => {
    for (const entry of _MANDATE_ERROR_TABLE_FOR_TEST) {
      const apiError = mandateErrorToApiError(decodeMandateErrorCode(entry.code));
      if (entry.name !== "ArithmeticOverflow") {
        expect(apiError.httpStatus).not.toBe(500);
      }
    }
  });
});
