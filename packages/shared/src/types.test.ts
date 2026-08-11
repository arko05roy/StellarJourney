import { describe, expect, it } from "vitest";
import {
  AmountRuleSchema,
  HexId32Schema,
  MandateInputSchema,
  MandateSchema,
  MandateStatusSchema,
  PaymentReceiptSchema,
  RefundReceiptSchema,
  StellarAccountAddressSchema,
  StellarContractAddressSchema,
} from "./types.js";

// Real testnet identities/contract (`stellar keys address paymap-payer` etc.,
// `deployments/testnet.json`'s asset.contractId) — used here only for their
// checksum-valid StrKey shape, not for any network call.
const PAYER = "GCAZZ4N5H3I4VUYUJHSHVIRQYRR62IPOJ4G6L2N2WAOYHNUTOKCQWWFF";
const MERCHANT = "GBGHMQGD7QJNGTZUCTZZUY2EO4BWF37K2K6MQCNO7IJJHCYQGTBUERV2";
const ASSET_CONTRACT = "CB223VUC7MMCFT352EO7QLLV6QWHXTDOXOHY2BW7DZTO3VXBXAI7DUZJ";
const HEX_ID = "aa".repeat(32);

describe("StellarAccountAddressSchema / StellarContractAddressSchema", () => {
  it("accepts well-formed, checksum-valid addresses", () => {
    expect(StellarAccountAddressSchema.safeParse(PAYER).success).toBe(true);
    expect(StellarContractAddressSchema.safeParse(ASSET_CONTRACT).success).toBe(true);
  });

  it("rejects a contract address passed where an account address is expected", () => {
    expect(StellarAccountAddressSchema.safeParse(ASSET_CONTRACT).success).toBe(false);
  });

  it("rejects a garbage string", () => {
    expect(StellarAccountAddressSchema.safeParse("not-an-address").success).toBe(false);
    expect(StellarAccountAddressSchema.safeParse("").success).toBe(false);
  });

  it("rejects a well-formed-looking address with a corrupted checksum", () => {
    const corrupted = PAYER.slice(0, -1) + (PAYER.endsWith("F") ? "G" : "F");
    expect(StellarAccountAddressSchema.safeParse(corrupted).success).toBe(false);
  });
});

describe("HexId32Schema", () => {
  it("accepts a 64-character hex string", () => {
    expect(HexId32Schema.safeParse(HEX_ID).success).toBe(true);
    expect(HexId32Schema.safeParse(HEX_ID.toUpperCase()).success).toBe(true);
  });

  it("rejects the wrong length or non-hex characters", () => {
    expect(HexId32Schema.safeParse("aa").success).toBe(false);
    expect(HexId32Schema.safeParse("zz".repeat(32)).success).toBe(false);
  });
});

describe("MandateStatusSchema", () => {
  it("accepts every contract status", () => {
    for (const status of ["Active", "Paused", "Revoked", "Completed", "Expired"]) {
      expect(MandateStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(MandateStatusSchema.safeParse("Cancelled").success).toBe(false);
  });
});

describe("AmountRuleSchema", () => {
  it("accepts a fixed rule with a positive bigint amount", () => {
    expect(AmountRuleSchema.safeParse({ kind: "fixed", amount: 100n }).success).toBe(true);
  });

  it("accepts a variable rule with a positive bigint max", () => {
    expect(AmountRuleSchema.safeParse({ kind: "variable", maxPerCharge: 500n }).success).toBe(true);
  });

  it("rejects a non-positive amount in either branch (mirrors InvalidAmount)", () => {
    expect(AmountRuleSchema.safeParse({ kind: "fixed", amount: 0n }).success).toBe(false);
    expect(AmountRuleSchema.safeParse({ kind: "variable", maxPerCharge: -1n }).success).toBe(false);
  });

  it("rejects a JS number where a bigint is required (CLAUDE.md §5 — never a float for token amounts)", () => {
    expect(AmountRuleSchema.safeParse({ kind: "fixed", amount: 100 }).success).toBe(false);
  });
});

function validMandateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    payer: PAYER,
    merchant: MERCHANT,
    asset: ASSET_CONTRACT,
    amountRule: { kind: "fixed", amount: 150_0000n },
    maxPerPeriod: 1_000_0000n,
    periodSeconds: 2_592_000n,
    minIntervalSeconds: 0n,
    startAt: 1_000n,
    expiresAt: 999_999_999n,
    maxSuccessfulCharges: 0,
    metadataHash: HEX_ID,
    clientNonce: HEX_ID,
    ...overrides,
  };
}

describe("MandateInputSchema", () => {
  it("accepts a well-formed input", () => {
    expect(MandateInputSchema.safeParse(validMandateInput()).success).toBe(true);
  });

  it("rejects expiresAt <= startAt", () => {
    expect(MandateInputSchema.safeParse(validMandateInput({ expiresAt: 1_000n, startAt: 1_000n })).success).toBe(false);
    expect(MandateInputSchema.safeParse(validMandateInput({ expiresAt: 500n, startAt: 1_000n })).success).toBe(false);
  });

  it("rejects payer === merchant (no self-mandates)", () => {
    expect(MandateInputSchema.safeParse(validMandateInput({ merchant: PAYER })).success).toBe(false);
  });

  it("allows maxSuccessfulCharges = 0 (unlimited, per contract convention)", () => {
    expect(MandateInputSchema.safeParse(validMandateInput({ maxSuccessfulCharges: 0 })).success).toBe(true);
  });
});

describe("MandateSchema", () => {
  it("accepts a full mandate record with lastChargedAt undefined (never charged yet)", () => {
    const mandate = {
      id: HEX_ID,
      payer: PAYER,
      merchant: MERCHANT,
      asset: ASSET_CONTRACT,
      status: "Active",
      amountRule: { kind: "fixed", amount: 150_0000n },
      maxPerPeriod: 1_000_0000n,
      periodSeconds: 2_592_000n,
      minIntervalSeconds: 0n,
      startAt: 1_000n,
      expiresAt: 999_999_999n,
      maxSuccessfulCharges: 0,
      successfulCharges: 0,
      totalCollected: 0n,
      currentPeriodStart: 1_000n,
      currentPeriodCollected: 0n,
      lastChargedAt: undefined,
      createdAt: 1_000n,
      metadataHash: HEX_ID,
    };
    expect(MandateSchema.safeParse(mandate).success).toBe(true);
  });

  it("accepts a mandate record with a set lastChargedAt", () => {
    const mandate = {
      id: HEX_ID,
      payer: PAYER,
      merchant: MERCHANT,
      asset: ASSET_CONTRACT,
      status: "Active",
      amountRule: { kind: "fixed", amount: 150_0000n },
      maxPerPeriod: 1_000_0000n,
      periodSeconds: 2_592_000n,
      minIntervalSeconds: 0n,
      startAt: 1_000n,
      expiresAt: 999_999_999n,
      maxSuccessfulCharges: 0,
      successfulCharges: 1,
      totalCollected: 150_0000n,
      currentPeriodStart: 1_000n,
      currentPeriodCollected: 150_0000n,
      lastChargedAt: 2_000n,
      createdAt: 1_000n,
      metadataHash: HEX_ID,
    };
    expect(MandateSchema.safeParse(mandate).success).toBe(true);
  });
});

describe("PaymentReceiptSchema / RefundReceiptSchema", () => {
  it("accepts a well-formed payment receipt", () => {
    expect(
      PaymentReceiptSchema.safeParse({
        paymentId: HEX_ID,
        mandateId: HEX_ID,
        chargeId: HEX_ID,
        payer: PAYER,
        merchant: MERCHANT,
        asset: ASSET_CONTRACT,
        amount: 150_0000n,
        invoiceHash: HEX_ID,
        timestamp: 1_000n,
      }).success,
    ).toBe(true);
  });

  it("accepts a well-formed refund receipt", () => {
    expect(
      RefundReceiptSchema.safeParse({
        refundId: HEX_ID,
        paymentId: HEX_ID,
        amount: 50_0000n,
        timestamp: 1_000n,
      }).success,
    ).toBe(true);
  });

  it("rejects a zero or negative amount", () => {
    expect(
      RefundReceiptSchema.safeParse({
        refundId: HEX_ID,
        paymentId: HEX_ID,
        amount: 0n,
        timestamp: 1_000n,
      }).success,
    ).toBe(false);
  });
});
