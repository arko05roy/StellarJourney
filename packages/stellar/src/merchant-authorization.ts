import {
  Address,
  Keypair,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  checkAuthEntryReadiness,
  hash,
  inspectAuthEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { SignAuthEntry } from "@stellar/stellar-sdk/contract";

export interface ChargeAuthorizationArgs {
  mandateId: string;
  chargeId: string;
  amount: bigint;
  invoiceHash: string;
}

export interface ChargeAuthorizationContext {
  contractId: string;
  networkPassphrase: string;
  merchantAddress: string;
}

function bytes32(value: string, field: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be 32 bytes encoded as hexadecimal.`);
  }
  return Buffer.from(value, "hex");
}

export function buildChargeAuthorizationInvocation(
  contractId: string,
  args: ChargeAuthorizationArgs,
): xdr.SorobanAuthorizedInvocation {
  const functionName = nativeToScVal("charge", { type: "symbol" }).sym();
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName,
        args: [
          nativeToScVal(bytes32(args.mandateId, "mandateId"), { type: "bytes" }),
          nativeToScVal(bytes32(args.chargeId, "chargeId"), { type: "bytes" }),
          nativeToScVal(args.amount, { type: "i128" }),
          nativeToScVal(bytes32(args.invoiceHash, "invoiceHash"), { type: "bytes" }),
        ],
      }),
    ),
    subInvocations: [],
  });
}

function randomNonce(): InstanceType<typeof xdr.Int64> {
  const bytes = Keypair.random().rawPublicKey();
  const nonce = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, false);
  return new xdr.Int64(nonce);
}

export function createUnsignedChargeAuthorization(
  context: ChargeAuthorizationContext,
  args: ChargeAuthorizationArgs,
  signatureExpirationLedger: number,
): string {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(context.merchantAddress).toScAddress(),
        nonce: randomNonce(),
        signatureExpirationLedger,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: buildChargeAuthorizationInvocation(context.contractId, args),
  });
  return entry.toXDR("base64");
}

export function authorizationPreimageXdr(
  unsignedEntryXdr: string,
  networkPassphrase: string,
): string {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(unsignedEntryXdr, "base64");
  const expiration = inspectAuthEntry(entry).signatureExpirationLedger;
  if (expiration === null) {
    throw new Error("Charge authorization must use address credentials.");
  }
  return buildAuthorizationEntryPreimage(entry, expiration, networkPassphrase).toXDR("base64");
}

export async function signChargeAuthorization(
  unsignedEntryXdr: string,
  context: ChargeAuthorizationContext,
  signAuthEntry: SignAuthEntry,
): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(unsignedEntryXdr, "base64");
  const info = inspectAuthEntry(entry);
  if (info.address !== context.merchantAddress || info.signatureExpirationLedger === null) {
    throw new Error("Authorization challenge does not belong to the configured merchant.");
  }
  const signed = await authorizeEntry(
    entry,
    async (preimage) => {
      const result = await signAuthEntry(preimage.toXDR("base64"), {
        address: context.merchantAddress,
        networkPassphrase: context.networkPassphrase,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Merchant rejected authorization signing.");
      }
      return Buffer.from(result.signedAuthEntry, "base64");
    },
    info.signatureExpirationLedger,
    context.networkPassphrase,
  );
  return signed.toXDR("base64");
}

export interface ValidateChargeAuthorizationInput {
  signedEntryXdr: string;
  context: ChargeAuthorizationContext;
  args: ChargeAuthorizationArgs;
  currentLedgerSeq: number;
  expectedExpirationLedger?: number;
}

export function validateChargeAuthorization(input: ValidateChargeAuthorizationInput): {
  signatureExpirationLedger: number;
} {
  const raw = Buffer.from(input.signedEntryXdr, "base64");
  if (raw.length === 0 || raw.length > 32_768) {
    throw new Error("Signed authorization XDR has an invalid size.");
  }
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(raw);
  const info = inspectAuthEntry(entry);
  const readiness = checkAuthEntryReadiness(entry, input.currentLedgerSeq);

  if (info.credentialType !== "address" || info.address !== input.context.merchantAddress) {
    throw new Error("Authorization signer does not match the merchant.");
  }
  if (!readiness.ready || info.signatureExpirationLedger === null) {
    throw new Error(
      readiness.expired ? "Authorization has expired." : "Authorization is unsigned.",
    );
  }
  if (
    input.expectedExpirationLedger !== undefined &&
    info.signatureExpirationLedger !== input.expectedExpirationLedger
  ) {
    throw new Error("Authorization expiry differs from the issued challenge.");
  }

  const expectedInvocation = buildChargeAuthorizationInvocation(
    input.context.contractId,
    input.args,
  );
  if (!info.invocation.toXDR().equals(expectedInvocation.toXDR())) {
    throw new Error("Authorization invocation does not match the charge request.");
  }

  const signer = info.signers[0];
  const signatures = signer?.signatures;
  if (
    info.signers.length !== 1 ||
    !signer ||
    signatures === null ||
    signatures === undefined ||
    signatures.length !== 1 ||
    signatures[0]?.publicKey !== input.context.merchantAddress
  ) {
    throw new Error("Authorization must contain exactly one standard merchant signature.");
  }
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    info.signatureExpirationLedger,
    input.context.networkPassphrase,
  );
  const signature = signatures[0];
  if (!signature) {
    throw new Error("Authorization signature is missing.");
  }
  if (
    !Keypair.fromPublicKey(input.context.merchantAddress).verify(
      hash(preimage.toXDR()),
      signature.signature,
    )
  ) {
    throw new Error("Authorization signature is invalid.");
  }

  return { signatureExpirationLedger: info.signatureExpirationLedger };
}
