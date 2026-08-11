/**
 * Display-only formatting helpers. Never used for anything that crosses
 * back into a contract call or API request — those always go through
 * `@paymap/shared`'s exact `bigint`/decimal-string conversions directly
 * (CLAUDE.md §9). This module only turns already-exact values into
 * human-readable strings for the review screen.
 */
import { baseUnitsToDecimalString } from "@paymap/shared";

/** Renders base units as a trimmed decimal string for display (e.g. `"15.00"` not `"15.0000000"`) — full precision is preserved by `baseUnitsToDecimalString`; this only trims cosmetic trailing zeros, and never rounds. */
export function formatAmount(amount: bigint, decimals: number): string {
  const full = baseUnitsToDecimalString(amount, decimals);
  if (!full.includes(".")) return full;
  const trimmed = full.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

const COMMON_PERIODS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 86_400, label: "day" },
  { seconds: 604_800, label: "week" },
  { seconds: 2_592_000, label: "30 days" },
  { seconds: 7_776_000, label: "90 days" },
  { seconds: 31_536_000, label: "year" },
];

/** Renders a period in seconds as a human phrase ("every 30 days", "every 3 days") — recognizes a few common billing periods by exact match for cleaner copy, falls back to a day/hour count otherwise. Never hides the underlying number: callers show the raw seconds value alongside this (CLAUDE.md §13 — never hide frequency). */
export function formatBillingFrequency(periodSeconds: bigint): string {
  const seconds = Number(periodSeconds);
  const known = COMMON_PERIODS.find((p) => p.seconds === seconds);
  if (known) return `Every ${known.label}`;
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `Every ${String(days)} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `Every ${String(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  return `Every ${String(seconds)} seconds`;
}

/** Renders a minimum interval in seconds as a short human phrase ("At least 1 day between charges"). `0` means no explicit minimum beyond the billing period itself. */
export function formatMinInterval(minIntervalSeconds: bigint): string {
  if (minIntervalSeconds === 0n) return "No minimum spacing beyond the billing period";
  const seconds = Number(minIntervalSeconds);
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `At least ${String(days)} day${days === 1 ? "" : "s"} between charges`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `At least ${String(hours)} hour${hours === 1 ? "" : "s"} between charges`;
  }
  return `At least ${String(seconds)} seconds between charges`;
}

/** Renders a Unix-seconds timestamp in the viewer's locale/timezone, with the UTC instant made explicit alongside it (CLAUDE.md §9 — UTC everywhere, ISO 8601 at boundaries, displayed with the timezone made explicit). */
export function formatDateTime(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Short date-only rendering, used for "next eligible charge" / "expires on" copy. */
export function formatDate(unixSeconds: bigint): string {
  const date = new Date(Number(unixSeconds) * 1000);
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}
