/**
 * Per-merchant webhook secret encryption at rest (CLAUDE.md §16 —
 * `WEBHOOK_ENCRYPTION_KEY`; CLAUDE.md §12's "webhook secrets are per-merchant,
 * encrypted at rest"). `Merchant.webhookSecret` (`prisma/schema.prisma`)
 * stores only the ciphertext this module produces — never the raw secret.
 *
 * AES-256-GCM (authenticated encryption — a corrupted/tampered ciphertext
 * fails to decrypt rather than silently producing garbage plaintext). The
 * 256-bit key is derived via SHA-256 from `WEBHOOK_ENCRYPTION_KEY` so the
 * env var itself can be any non-empty string (matching its existing Zod
 * schema in `packages/config`) rather than requiring an exact 32-byte
 * hex/base64 value operators must get precisely right.
 *
 * Stored format: `v1:<iv hex>:<authTag hex>:<ciphertext hex>` — versioned so
 * a future scheme change can coexist with already-stored ciphertexts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";
/** 96-bit IV — the size AES-GCM is specified and optimized for. */
const IV_LENGTH_BYTES = 12;

export class WebhookSecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretCryptoError";
  }
}

function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length === 0) {
    throw new WebhookSecretCryptoError("Encryption key material must not be empty.");
  }
  return createHash("sha256").update(keyMaterial, "utf8").digest();
}

/** Generates a fresh random webhook secret in `whsec_<base64url>` form (mirrors `sk_live_` API keys' shape/entropy). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** Encrypts a plaintext webhook secret for storage in `Merchant.webhookSecret`. */
export function encryptWebhookSecret(plaintext: string, keyMaterial: string): string {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

/** Decrypts a `Merchant.webhookSecret` ciphertext back to the raw secret. Throws {@link WebhookSecretCryptoError} on a wrong key or corrupted/tampered ciphertext (AES-GCM's auth tag check fails). */
export function decryptWebhookSecret(stored: string, keyMaterial: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new WebhookSecretCryptoError(`Unrecognized encrypted webhook secret format (expected "${FORMAT_VERSION}:<iv>:<tag>:<ciphertext>").`);
  }
  const [, ivHex, tagHex, ciphertextHex] = parts as [string, string, string, string];
  const key = deriveKey(keyMaterial);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Deliberately no `{ cause: error }` — never surface the underlying
    // crypto library error's message, which can include buffer contents.
    throw new WebhookSecretCryptoError("Failed to decrypt webhook secret (wrong WEBHOOK_ENCRYPTION_KEY or corrupted ciphertext).");
  }
}
