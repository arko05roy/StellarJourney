import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hash, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import {
  createUnsignedChargeAuthorization,
  signChargeAuthorization,
  validateChargeAuthorization,
} from "./merchant-authorization.js";

function fixture() {
  const merchant = Keypair.random();
  const context = {
    merchantAddress: merchant.publicKey(),
    contractId: StrKey.encodeContract(randomBytes(32)),
    networkPassphrase: Networks.TESTNET,
  };
  const args = {
    mandateId: randomBytes(32).toString("hex"),
    chargeId: randomBytes(32).toString("hex"),
    amount: 15_0000000n,
    invoiceHash: randomBytes(32).toString("hex"),
  };
  return { merchant, context, args };
}

async function sign(
  merchant: Keypair,
  context: ReturnType<typeof fixture>["context"],
  args: ReturnType<typeof fixture>["args"],
  expiration = 1_001_000,
) {
  const unsigned = createUnsignedChargeAuthorization(context, args, expiration);
  return signChargeAuthorization(unsigned, context, async (preimage) => ({
    signedAuthEntry: merchant.sign(hash(Buffer.from(preimage, "base64"))).toString("base64"),
  }));
}

describe("merchant charge authorization", () => {
  it("accepts one valid invocation-bound merchant signature", async () => {
    const { merchant, context, args } = fixture();
    const signedEntryXdr = await sign(merchant, context, args);
    expect(
      validateChargeAuthorization({
        signedEntryXdr,
        context,
        args,
        currentLedgerSeq: 1_000_000,
        expectedExpirationLedger: 1_001_000,
      }),
    ).toEqual({ signatureExpirationLedger: 1_001_000 });
  });

  it("rejects amount, contract, network, expiry, and signer replay", async () => {
    const { merchant, context, args } = fixture();
    const signedEntryXdr = await sign(merchant, context, args);
    const base = {
      signedEntryXdr,
      context,
      args,
      currentLedgerSeq: 1_000_000,
      expectedExpirationLedger: 1_001_000,
    };

    expect(() =>
      validateChargeAuthorization({
        ...base,
        args: { ...args, amount: args.amount + 1n },
      }),
    ).toThrow("invocation");
    expect(() =>
      validateChargeAuthorization({
        ...base,
        context: { ...context, contractId: StrKey.encodeContract(randomBytes(32)) },
      }),
    ).toThrow("invocation");
    expect(() =>
      validateChargeAuthorization({
        ...base,
        context: { ...context, networkPassphrase: Networks.PUBLIC },
      }),
    ).toThrow("signature is invalid");
    expect(() => validateChargeAuthorization({ ...base, currentLedgerSeq: 1_001_000 })).toThrow(
      "expired",
    );
    expect(() =>
      validateChargeAuthorization({
        ...base,
        context: { ...context, merchantAddress: Keypair.random().publicKey() },
      }),
    ).toThrow("signer");
  });
});
