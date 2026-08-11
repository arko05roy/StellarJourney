import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { _MANDATE_ERROR_TABLE_FOR_TEST, decodeMandateErrorCode, decodeMandateErrorFromResult, MandateContractError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const ERROR_RS_PATH = join(here, "..", "..", "..", "contracts", "mandate-registry", "src", "error.rs");

/**
 * Parses `#[contracterror] pub enum Error { Name = N, ... }` discriminants
 * directly out of the Rust source. Deliberately dumb (line-oriented regex,
 * not a real Rust parser) — good enough for a frozen, single-file, one-enum
 * ABI, and it fails loudly (empty match set) rather than silently if the
 * file's shape ever changes enough to matter.
 */
function parseRustErrorTable(source: string): Array<{ name: string; code: number }> {
  const entries: Array<{ name: string; code: number }> = [];
  const pattern = /^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+),/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const code = match[2];
    if (name === undefined || code === undefined) continue;
    entries.push({ name, code: Number(code) });
  }
  return entries;
}

describe("MANDATE_ERROR_TABLE matches contracts/mandate-registry/src/error.rs exactly", () => {
  const rustSource = readFileSync(ERROR_RS_PATH, "utf-8");
  const rustTable = parseRustErrorTable(rustSource);

  it("parsed at least the frozen 24 entries from the Rust source (sanity check on the parser itself)", () => {
    expect(rustTable.length).toBeGreaterThanOrEqual(24);
  });

  it("has exactly the same (code, name) pairs as the Rust enum, in either order", () => {
    const rustSorted = [...rustTable].sort((a, b) => a.code - b.code);
    const tsSorted = [..._MANDATE_ERROR_TABLE_FOR_TEST].map((e) => ({ name: e.name, code: e.code })).sort((a, b) => a.code - b.code);
    expect(tsSorted).toEqual(rustSorted);
  });

  it("every TS entry's name matches the Rust variant at the same code", () => {
    const rustByCode = new Map(rustTable.map((e) => [e.code, e.name]));
    for (const entry of _MANDATE_ERROR_TABLE_FOR_TEST) {
      expect(rustByCode.get(entry.code), `code ${String(entry.code)}`).toBe(entry.name);
    }
  });
});

describe("decodeMandateErrorCode", () => {
  it("decodes a known code with its retryable classification", () => {
    const revoked = decodeMandateErrorCode(4);
    expect(revoked.info).toEqual({ code: 4, name: "MandateRevoked", retryable: false });
    expect(revoked).toBeInstanceOf(MandateContractError);
  });

  it("classifies the CLAUDE.md §11 'never retry' set as non-retryable", () => {
    for (const code of [4, 6, 13, 10, 11, 8, 12, 19]) {
      expect(decodeMandateErrorCode(code).retryable, `code ${String(code)}`).toBe(false);
    }
  });

  it("classifies allowance/balance failures as retryable (per merchant policy)", () => {
    expect(decodeMandateErrorCode(15).retryable).toBe(true);
    expect(decodeMandateErrorCode(16).retryable).toBe(true);
  });

  it("falls back to a safe, non-retryable unknown entry for an out-of-table code", () => {
    const decoded = decodeMandateErrorCode(9999);
    expect(decoded.retryable).toBe(false);
    expect(decoded.code).toBe(9999);
  });
});

describe("decodeMandateErrorFromResult", () => {
  it("decodes the {message} shape the generated client's Result.unwrapErr() returns", () => {
    const decoded = decodeMandateErrorFromResult({ message: "InsufficientBalance" });
    expect(decoded.code).toBe(16);
    expect(decoded.retryable).toBe(true);
  });
});
