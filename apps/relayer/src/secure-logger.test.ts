import { describe, expect, it } from "vitest";
import { createSafeJsonLogger, redactLogFields } from "./secure-logger.js";

describe("secure structured logger", () => {
  it("recursively redacts named secrets and secret-shaped values", () => {
    const stellarSeed = `S${"A".repeat(55)}`;
    expect(
      redactLogFields({
        merchantId: "merchant_1",
        authorization: "Bearer api-secret",
        nested: { webhookSecret: "whsec_hidden", message: `failed for ${stellarSeed}` },
      }),
    ).toEqual({
      merchantId: "merchant_1",
      authorization: "[REDACTED]",
      nested: { webhookSecret: "[REDACTED]", message: "failed for [REDACTED]" },
    });
  });

  it("emits JSON with required correlation fields while never emitting secrets", () => {
    const lines: string[] = [];
    const logger = createSafeJsonLogger("relayer", (_level, line) => lines.push(line));
    logger("info", "charge_request.succeeded", {
      mandateId: "mandate_1",
      chargeId: "charge_1",
      merchantId: "merchant_1",
      transactionHash: "tx_1",
      requestId: "request_1",
      apiKey: "sk_live_must_not_leak",
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "charge_request.succeeded",
      mandateId: "mandate_1",
      chargeId: "charge_1",
      merchantId: "merchant_1",
      transactionHash: "tx_1",
      requestId: "request_1",
      apiKey: "[REDACTED]",
    });
    expect(lines[0]).not.toContain("must_not_leak");
  });
});
