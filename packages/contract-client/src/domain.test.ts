import { describe, expect, it } from "vitest";
import {
  fromDomainAmountRule,
  hexToId,
  idToHex,
  toDomainAmountRule,
  toDomainMandate,
  toDomainMandateStatus,
  toDomainPaymentReceipt,
  toDomainRefundReceipt,
  type AmountRule,
} from "./domain.js";
import type {
  Mandate as GenMandate,
  PaymentReceipt as GenPaymentReceipt,
  RefundReceipt as GenRefundReceipt,
} from "./generated/mandate-registry.js";

const HEX_A = "aa".repeat(32);
const HEX_B = "bb".repeat(32);

describe("idToHex / hexToId", () => {
  it("round-trips a 32-byte buffer through hex", () => {
    const original = Buffer.from(HEX_A, "hex");
    expect(idToHex(hexToId(idToHex(original)))).toBe(HEX_A);
  });

  it("rejects a hex string of the wrong length", () => {
    expect(() => hexToId("aa")).toThrow();
    expect(() => hexToId(HEX_A + "aa")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => hexToId("zz".repeat(32))).toThrow();
  });

  it("accepts uppercase hex", () => {
    expect(hexToId(HEX_A.toUpperCase())).toEqual(Buffer.from(HEX_A, "hex"));
  });
});

describe("AmountRule domain <-> generated round-trip", () => {
  const cases: AmountRule[] = [
    { kind: "fixed", amount: 1_500_0000n },
    { kind: "variable", maxPerCharge: 999_999_999_999n },
  ];

  for (const domainRule of cases) {
    it(`round-trips ${domainRule.kind}`, () => {
      const generated = fromDomainAmountRule(domainRule);
      expect(toDomainAmountRule(generated)).toEqual(domainRule);
    });
  }

  it("maps the generated tuple-variant tag correctly", () => {
    expect(toDomainAmountRule({ tag: "Fixed", values: [42n] })).toEqual({
      kind: "fixed",
      amount: 42n,
    });
    expect(toDomainAmountRule({ tag: "Variable", values: [42n] })).toEqual({
      kind: "variable",
      maxPerCharge: 42n,
    });
  });
});

describe("toDomainMandateStatus", () => {
  it("passes the tag through unchanged", () => {
    expect(toDomainMandateStatus({ tag: "Active", values: undefined })).toBe("Active");
    expect(toDomainMandateStatus({ tag: "Expired", values: undefined })).toBe("Expired");
  });
});

describe("toDomainMandate", () => {
  it("converts every field, keeping i128/u64 as bigint and ids as hex", () => {
    const generated: GenMandate = {
      id: Buffer.from(HEX_A, "hex"),
      payer: "GPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPX",
      merchant: "GMERCHANTMERCHANTMERCHANTMERCHANTMERCHANTMERCHANTMX",
      asset: "CASSETASSETASSETASSETASSETASSETASSETASSETASSETASSETX",
      status: { tag: "Active", values: undefined },
      amount_rule: { tag: "Fixed", values: [15_000_0000n] },
      max_per_period: 100_000_0000n,
      period_seconds: 2_592_000n,
      min_interval_seconds: 0n,
      start_at: 1_000n,
      expires_at: 999_999_999n,
      max_successful_charges: 12,
      successful_charges: 3,
      total_collected: 45_000_0000n,
      current_period_start: 1_000n,
      current_period_collected: 15_000_0000n,
      last_charged_at: 2_000n,
      created_at: 999n,
      metadata_hash: Buffer.from(HEX_B, "hex"),
    };

    const domain = toDomainMandate(generated);

    expect(domain).toEqual({
      id: HEX_A,
      payer: generated.payer,
      merchant: generated.merchant,
      asset: generated.asset,
      status: "Active",
      amountRule: { kind: "fixed", amount: 15_000_0000n },
      maxPerPeriod: 100_000_0000n,
      periodSeconds: 2_592_000n,
      minIntervalSeconds: 0n,
      startAt: 1_000n,
      expiresAt: 999_999_999n,
      maxSuccessfulCharges: 12,
      successfulCharges: 3,
      totalCollected: 45_000_0000n,
      currentPeriodStart: 1_000n,
      currentPeriodCollected: 15_000_0000n,
      lastChargedAt: 2_000n,
      createdAt: 999n,
      metadataHash: HEX_B,
    });

    // Every money/time field must be a bigint, never a JS number (CLAUDE.md §5).
    expect(typeof domain.maxPerPeriod).toBe("bigint");
    expect(typeof domain.totalCollected).toBe("bigint");
    expect(typeof domain.currentPeriodCollected).toBe("bigint");
    expect(typeof domain.lastChargedAt).toBe("bigint");
  });

  it("passes through an absent last_charged_at as undefined", () => {
    const generated: GenMandate = {
      id: Buffer.from(HEX_A, "hex"),
      payer: "G...",
      merchant: "G...",
      asset: "C...",
      status: { tag: "Active", values: undefined },
      amount_rule: { tag: "Variable", values: [500_0000n] },
      max_per_period: 1_000_0000n,
      period_seconds: 604_800n,
      min_interval_seconds: 86_400n,
      start_at: 0n,
      expires_at: 999_999_999n,
      max_successful_charges: 0,
      successful_charges: 0,
      total_collected: 0n,
      current_period_start: 0n,
      current_period_collected: 0n,
      last_charged_at: undefined,
      created_at: 0n,
      metadata_hash: Buffer.from(HEX_B, "hex"),
    };
    expect(toDomainMandate(generated).lastChargedAt).toBeUndefined();
  });

  it("normalizes the live SDK's null Option::None to undefined", () => {
    const generated: GenMandate = {
      id: Buffer.from(HEX_A, "hex"),
      payer: "G...",
      merchant: "G...",
      asset: "C...",
      status: { tag: "Active", values: undefined },
      amount_rule: { tag: "Fixed", values: [1n] },
      max_per_period: 1n,
      period_seconds: 1n,
      min_interval_seconds: 0n,
      start_at: 0n,
      expires_at: 2n,
      max_successful_charges: 1,
      successful_charges: 0,
      total_collected: 0n,
      current_period_start: 0n,
      current_period_collected: 0n,
      last_charged_at: null as unknown as undefined,
      created_at: 0n,
      metadata_hash: Buffer.from(HEX_B, "hex"),
    };

    expect(toDomainMandate(generated).lastChargedAt).toBeUndefined();
  });
});

describe("toDomainPaymentReceipt / toDomainRefundReceipt", () => {
  it("converts a payment receipt", () => {
    const generated: GenPaymentReceipt = {
      payment_id: Buffer.from(HEX_A, "hex"),
      mandate_id: Buffer.from(HEX_B, "hex"),
      charge_id: Buffer.from(HEX_A, "hex"),
      payer: "G...",
      merchant: "G...",
      asset: "C...",
      amount: 15_000_0000n,
      invoice_hash: Buffer.from(HEX_B, "hex"),
      timestamp: 12_345n,
    };
    const domain = toDomainPaymentReceipt(generated);
    expect(domain.paymentId).toBe(HEX_A);
    expect(domain.mandateId).toBe(HEX_B);
    expect(domain.amount).toBe(15_000_0000n);
    expect(typeof domain.amount).toBe("bigint");
  });

  it("converts a refund receipt", () => {
    const generated: GenRefundReceipt = {
      refund_id: Buffer.from(HEX_A, "hex"),
      payment_id: Buffer.from(HEX_B, "hex"),
      amount: 500_0000n,
      timestamp: 12_345n,
    };
    const domain = toDomainRefundReceipt(generated);
    expect(domain.refundId).toBe(HEX_A);
    expect(domain.paymentId).toBe(HEX_B);
    expect(typeof domain.amount).toBe("bigint");
  });
});
