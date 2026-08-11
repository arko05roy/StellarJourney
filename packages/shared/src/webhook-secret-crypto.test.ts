import { describe, expect, it } from "vitest";
import { WebhookSecretCryptoError, decryptWebhookSecret, encryptWebhookSecret, generateWebhookSecret } from "./webhook-secret-crypto.js";

const KEY = "test-webhook-encryption-key-material";

describe("encryptWebhookSecret / decryptWebhookSecret", () => {
  it("round-trips a secret", () => {
    const secret = generateWebhookSecret();
    const encrypted = encryptWebhookSecret(secret, KEY);
    expect(encrypted).not.toContain(secret);
    expect(decryptWebhookSecret(encrypted, KEY)).toBe(secret);
  });

  it("produces a different ciphertext every time (random IV) even for the same plaintext/key", () => {
    const secret = "whsec_fixed_value";
    const a = encryptWebhookSecret(secret, KEY);
    const b = encryptWebhookSecret(secret, KEY);
    expect(a).not.toBe(b);
    expect(decryptWebhookSecret(a, KEY)).toBe(secret);
    expect(decryptWebhookSecret(b, KEY)).toBe(secret);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptWebhookSecret("whsec_abc", KEY);
    expect(() => decryptWebhookSecret(encrypted, "a-completely-different-key")).toThrow(WebhookSecretCryptoError);
  });

  it("fails to decrypt a tampered ciphertext (auth tag mismatch)", () => {
    const encrypted = encryptWebhookSecret("whsec_abc", KEY);
    const parts = encrypted.split(":");
    // Flip a hex character in the ciphertext portion.
    const tamperedCiphertext = (parts[3] ?? "").replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const tampered = [parts[0], parts[1], parts[2], tamperedCiphertext].join(":");
    expect(() => decryptWebhookSecret(tampered, KEY)).toThrow(WebhookSecretCryptoError);
  });

  it("rejects an unrecognized stored format", () => {
    expect(() => decryptWebhookSecret("not-the-right-format", KEY)).toThrow(WebhookSecretCryptoError);
    expect(() => decryptWebhookSecret("v2:aa:bb:cc", KEY)).toThrow(WebhookSecretCryptoError);
  });

  it("generated secrets have the expected prefix and are unique", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
