import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { decodeMandateLifecycleEvent, MandateEventDecodeError, type MandateLifecycleEventKind } from "./events.js";
import { idToHex } from "./domain.js";

/**
 * Fixtures built to match exactly what `soroban-sdk-macros-27.0.2`'s
 * `derive_event.rs` produces for a `#[contractevent]` (verified by reading
 * that macro's source directly, not assumed): topics =
 * `[Symbol(event_name), ...#[topic] fields]`, data = an `ScvMap` keyed by
 * field name. This proves `decodeMandateLifecycleEvent` against a
 * representative real payload shape, not a hand-wavy stand-in.
 */
function symbol(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "symbol" });
}

function mapVal(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => new xdr.ScMapEntry({ key: symbol(key), val })),
  );
}

const PAYER = Keypair.random().publicKey();
const MERCHANT = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(randomBytes(32));
const MANDATE_ID_BYTES = randomBytes(32);
const TX_HASH = "a".repeat(64);

function buildRaw(
  kind: MandateLifecycleEventKind | "charge_succeeded" | "refund_succeeded" | "something_unrecognized",
  data: Record<string, xdr.ScVal>,
  overrides: Partial<{ id: string; ledger: number; inSuccessfulContractCall: boolean; topic: xdr.ScVal[] }> = {},
): rpc.Api.EventResponse {
  return {
    id: overrides.id ?? "0000004000-0000000001",
    type: "contract",
    ledger: overrides.ledger ?? 4000,
    ledgerClosedAt: new Date(0).toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: overrides.inSuccessfulContractCall ?? true,
    txHash: TX_HASH,
    topic:
      overrides.topic ??
      [symbol(kind), nativeToScVal(MANDATE_ID_BYTES, { type: "bytes" }), nativeToScVal(PAYER, { type: "address" }), nativeToScVal(MERCHANT, { type: "address" })],
    value: mapVal(data),
  } as unknown as rpc.Api.EventResponse;
}

describe("decodeMandateLifecycleEvent", () => {
  it("decodes mandate_created (full mandate terms in data)", () => {
    const raw = buildRaw("mandate_created", {
      asset: nativeToScVal(ASSET, { type: "address" }),
      timestamp: nativeToScVal(1_700_000_000n, { type: "u64" }),
      amount_rule: xdr.ScVal.scvVec([symbol("Fixed"), nativeToScVal(150_000_000n, { type: "i128" })]),
      max_per_period: nativeToScVal(0n, { type: "i128" }),
      period_seconds: nativeToScVal(2_592_000n, { type: "u64" }),
      min_interval_seconds: nativeToScVal(86_400n, { type: "u64" }),
      start_at: nativeToScVal(0n, { type: "u64" }),
      expires_at: nativeToScVal(1_800_000_000n, { type: "u64" }),
      max_successful_charges: nativeToScVal(12, { type: "u32" }),
      metadata_hash: nativeToScVal(randomBytes(32), { type: "bytes" }),
    });

    expect(decodeMandateLifecycleEvent(raw)).toEqual({
      kind: "mandate_created",
      mandateId: idToHex(MANDATE_ID_BYTES),
      payer: PAYER,
      merchant: MERCHANT,
      timestamp: 1_700_000_000n,
      asset: ASSET,
      ledger: 4000,
      txHash: TX_HASH,
      rpcEventId: "0000004000-0000000001",
    });
  });

  it("decodes mandate_paused", () => {
    const raw = buildRaw("mandate_paused", { timestamp: nativeToScVal(1_700_000_100n, { type: "u64" }) });
    expect(decodeMandateLifecycleEvent(raw)).toEqual({
      kind: "mandate_paused",
      mandateId: idToHex(MANDATE_ID_BYTES),
      payer: PAYER,
      merchant: MERCHANT,
      timestamp: 1_700_000_100n,
      ledger: 4000,
      txHash: TX_HASH,
      rpcEventId: "0000004000-0000000001",
    });
  });

  it("decodes mandate_resumed", () => {
    const raw = buildRaw("mandate_resumed", { timestamp: nativeToScVal(1_700_000_200n, { type: "u64" }) });
    expect(decodeMandateLifecycleEvent(raw)?.kind).toBe("mandate_resumed");
  });

  it("decodes mandate_revoked", () => {
    const raw = buildRaw("mandate_revoked", { timestamp: nativeToScVal(1_700_000_300n, { type: "u64" }) });
    expect(decodeMandateLifecycleEvent(raw)?.kind).toBe("mandate_revoked");
  });

  it("decodes mandate_completed (successful_charges in data)", () => {
    const raw = buildRaw("mandate_completed", {
      timestamp: nativeToScVal(1_700_000_400n, { type: "u64" }),
      successful_charges: nativeToScVal(12, { type: "u32" }),
    });
    expect(decodeMandateLifecycleEvent(raw)).toEqual({
      kind: "mandate_completed",
      mandateId: idToHex(MANDATE_ID_BYTES),
      payer: PAYER,
      merchant: MERCHANT,
      timestamp: 1_700_000_400n,
      successfulCharges: 12,
      ledger: 4000,
      txHash: TX_HASH,
      rpcEventId: "0000004000-0000000001",
    });
  });

  it("returns undefined for charge_succeeded/refund_succeeded — out of this indexer's scope, already have producers", () => {
    const charge = buildRaw("charge_succeeded", { timestamp: nativeToScVal(1n, { type: "u64" }) });
    const refund = buildRaw("refund_succeeded", { timestamp: nativeToScVal(1n, { type: "u64" }) });
    expect(decodeMandateLifecycleEvent(charge)).toBeUndefined();
    expect(decodeMandateLifecycleEvent(refund)).toBeUndefined();
  });

  it("returns undefined for an unrecognized event name (forward-compatible, never throws)", () => {
    const raw = buildRaw("something_unrecognized", { timestamp: nativeToScVal(1n, { type: "u64" }) });
    expect(decodeMandateLifecycleEvent(raw)).toBeUndefined();
  });

  it("throws MandateEventDecodeError when a lifecycle event's topic shape is wrong", () => {
    const badTopic = buildRaw("mandate_paused", { timestamp: nativeToScVal(1n, { type: "u64" }) }, { topic: [symbol("mandate_paused"), symbol("not-bytes"), symbol(PAYER), symbol(MERCHANT)] });
    expect(() => decodeMandateLifecycleEvent(badTopic)).toThrow(MandateEventDecodeError);
  });

  it("throws MandateEventDecodeError when data.timestamp is missing/wrong-typed", () => {
    const raw = buildRaw("mandate_paused", { timestamp: nativeToScVal(1, { type: "u32" }) });
    expect(() => decodeMandateLifecycleEvent(raw)).toThrow(MandateEventDecodeError);
  });

  it("throws MandateEventDecodeError when mandate_created is missing its asset field", () => {
    const raw = buildRaw("mandate_created", { timestamp: nativeToScVal(1n, { type: "u64" }) });
    expect(() => decodeMandateLifecycleEvent(raw)).toThrow(MandateEventDecodeError);
  });

  it("throws MandateEventDecodeError when mandate_completed is missing its successful_charges field", () => {
    const raw = buildRaw("mandate_completed", { timestamp: nativeToScVal(1n, { type: "u64" }) });
    expect(() => decodeMandateLifecycleEvent(raw)).toThrow(MandateEventDecodeError);
  });
});
