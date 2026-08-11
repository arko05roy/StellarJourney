import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";
const IV_LENGTH_BYTES = 12;

export class ChargeAuthorizationCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeAuthorizationCryptoError";
  }
}

function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length === 0) {
    throw new ChargeAuthorizationCryptoError(
      "Charge authorization encryption key must not be empty.",
    );
  }
  return createHash("sha256").update(keyMaterial, "utf8").digest();
}

export function encryptChargeAuthorization(plaintext: string, keyMaterial: string): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

export function decryptChargeAuthorization(stored: string, keyMaterial: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new ChargeAuthorizationCryptoError("Unrecognized charge authorization ciphertext.");
  }
  const [, ivHex, tagHex, ciphertextHex] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(keyMaterial), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ChargeAuthorizationCryptoError("Failed to decrypt charge authorization ciphertext.");
  }
}
