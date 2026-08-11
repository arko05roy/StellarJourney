/**
 * Browser-side 32-byte id generation (`client_nonce`, `metadata_hash`) using
 * the Web Crypto API — never `Math.random()` (not cryptographically strong,
 * and PLAN.md §10.2's collision-resistance argument for `mandate_id`
 * derivation depends on `client_nonce` being unpredictable).
 */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A fresh random 32-byte hex id — used as the mandate's `client_nonce` (PLAN.md §10.2: "the user or checkout flow supplies a unique client_nonce"). */
export function randomHexId32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** SHA-256 of a UTF-8 string, hex-encoded — used for `metadata_hash` (CLAUDE.md §6: "Store hashes and keep descriptive metadata off-chain", never plaintext product descriptions on-chain). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}
