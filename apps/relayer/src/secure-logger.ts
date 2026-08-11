import type { Logger } from "./pipeline.js";

const SENSITIVE_KEY =
  /^(?:authorization|apiKey|apiKeyHashSecret|keyHash|password|privateKey|relayerSecretKey|secret|seed|token|webhookEncryptionKey|webhookSecret)$/i;
const SECRET_VALUE =
  /(?:Bearer\s+\S+|S[A-Z2-7]{55}\b|sk_(?:live|test)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+)/g;
const REDACTED = "[REDACTED]";

export function redactLogFields(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return value.replace(SECRET_VALUE, REDACTED);
  if (Array.isArray(value)) return value.map((item) => redactLogFields(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactLogFields(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function createSafeJsonLogger(
  scope: string,
  write: (level: "info" | "warn" | "error", line: string) => void,
): Logger {
  return (level, event, fields) => {
    write(
      level,
      JSON.stringify({
        scope,
        level,
        event,
        ...(redactLogFields(fields) as Record<string, unknown>),
      }),
    );
  };
}
