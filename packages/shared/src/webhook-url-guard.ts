/**
 * SSRF hardening for merchant-supplied webhook URLs (CLAUDE.md §10, and
 * this phase's explicit decision #8). A merchant registering a webhook URL
 * — and the delivery worker about to POST to it — must never be able to
 * make this backend issue a request to an internal/loopback/link-local
 * address (cloud metadata endpoints, the Postgres/Redis containers, other
 * internal services, etc.).
 *
 * What is enforced:
 *   - Only `https:` (or `http:` when `allowInsecureHttp` is explicitly set —
 *     local dev only, never production default).
 *   - The hostname must not resolve (directly, if it's a literal IP, or via
 *     DNS otherwise) to a private/loopback/link-local/reserved address —
 *     IPv4 (RFC1918, 127/8, 169.254/16, 100.64/10 CGNAT, 0.0.0.0/8, multicast
 *     224/4+) and IPv6 (::1, fc00::/7 unique-local, fe80::/10 link-local,
 *     IPv4-mapped addresses checked against the same IPv4 rules).
 *
 * DNS rebinding: this function alone only closes the "resolve once, block if
 * bad" gap — a caller that later does its own DNS lookup to actually connect
 * can still be rebound to a different address between the two lookups. The
 * caller that performs the real HTTP request (`apps/relayer`'s delivery
 * worker) *pins* the connection to the exact `resolvedAddresses` this
 * function returns (see `webhook-http.ts`) rather than re-resolving,
 * closing that gap for the delivery path specifically. Registration-time
 * validation (`apps/api`) does not need pinning — it makes no outbound
 * request itself.
 *
 * `resolveHost` is injectable so callers (and this module's own tests) can
 * avoid a real DNS lookup — production code omits it and gets `node:dns`'s
 * `lookup`.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type WebhookUrlGuardErrorCode = "INVALID_URL" | "INVALID_PROTOCOL" | "INSECURE_PROTOCOL" | "BLOCKED_HOST" | "DNS_RESOLUTION_FAILED";

export class UnsafeWebhookUrlError extends Error {
  readonly code: WebhookUrlGuardErrorCode;

  constructor(code: WebhookUrlGuardErrorCode, message: string) {
    super(message);
    this.name = "UnsafeWebhookUrlError";
    this.code = code;
  }
}

export interface ResolvedHostAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedHostAddress[]>;

async function defaultResolveHost(hostname: string): Promise<ResolvedHostAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

function isPrivateOrReservedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 127) return true; // loopback (127/8)
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Expands a (possibly `::`-compressed) IPv6 address into its 8 hextets, or `null` if malformed. Ignores a trailing `%zone` id. */
function expandIPv6Hextets(address: string): string[] | null {
  const bare = address.split("%")[0] ?? address;
  if (bare.includes("::")) {
    const sides = bare.split("::");
    if (sides.length !== 2) return null;
    const head = sides[0] ? sides[0].split(":") : [];
    const tail = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    return [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  const parts = bare.split(":");
  return parts.length === 8 ? parts : null;
}

/** Decodes an IPv6-mapped-IPv4 address in its *compressed-hex* form (e.g. `::ffff:7f00:1`, what `URL`/`net.isIP` normalize `::ffff:127.0.0.1` to) back to dotted-quad IPv4, or `null` if `address` isn't such a mapping. The literal dotted form (`::ffff:127.0.0.1`) is checked separately since it isn't valid hex. */
function ipv6MappedHexToIPv4(address: string): string | null {
  const hextets = expandIPv6Hextets(address);
  if (!hextets) return null;
  const values = hextets.map((h) => parseInt(h === "" ? "0" : h, 16));
  if (values.some((v) => Number.isNaN(v))) return null;
  if (!values.slice(0, 5).every((v) => v === 0) || values[5] !== 0xffff) return null;
  const high = values[6] ?? 0;
  const low = values[7] ?? 0;
  return `${String((high >> 8) & 0xff)}.${String(high & 0xff)}.${String((low >> 8) & 0xff)}.${String(low & 0xff)}`;
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local

  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedDotted?.[1] && isIP(mappedDotted[1]) === 4) return isPrivateOrReservedIPv4(mappedDotted[1]);

  const mappedHex = ipv6MappedHexToIPv4(lower);
  if (mappedHex) return isPrivateOrReservedIPv4(mappedHex);

  return false;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateOrReservedIPv4(address);
  if (family === 6) return isPrivateOrReservedIPv6(address);
  return true; // not a recognizable IP at all — refuse rather than guess
}

export interface AssertSafeWebhookUrlOptions {
  /** Permits `http:` URLs — never the production default; scope to explicit local-dev configuration only. */
  allowInsecureHttp?: boolean;
  /** Injectable DNS resolver (tests only) — defaults to a real `node:dns` lookup. */
  resolveHost?: HostResolver;
  /**
   * Bypasses the private/loopback/link-local IP-range block (the protocol
   * check above is unaffected). Exists solely so integration tests can run
   * a real local HTTP receiver end-to-end (this phase's required
   * "a sample merchant app receives payment.succeeded" proof needs an
   * actual reachable server, and a real server in this environment is
   * necessarily bound to a loopback address) — never set from any
   * production code path (`apps/api`'s registration route and
   * `apps/relayer`'s delivery worker both always omit this). If a future
   * genuine local-dev workflow wants to hit `localhost` deliberately, wire
   * it through an explicit, separately-named env flag at that call site —
   * do not repurpose this flag for that.
   */
  allowPrivateAddresses?: boolean;
}

export interface SafeWebhookUrlInfo {
  hostname: string;
  resolvedAddresses: ResolvedHostAddress[];
}

/**
 * Throws {@link UnsafeWebhookUrlError} if `rawUrl` is not an acceptable
 * webhook destination; otherwise returns the hostname and every address it
 * resolved to (the caller that will actually connect should pin to these —
 * see this module's doc comment).
 */
export async function assertSafeWebhookUrl(rawUrl: string, options: AssertSafeWebhookUrlOptions = {}): Promise<SafeWebhookUrlInfo> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError("INVALID_URL", `"${rawUrl}" is not a valid URL.`);
  }

  if (url.protocol === "https:") {
    // fine
  } else if (url.protocol === "http:") {
    if (!options.allowInsecureHttp) {
      throw new UnsafeWebhookUrlError("INSECURE_PROTOCOL", "Webhook URLs must use https:// (http:// is only permitted in explicitly-configured local dev).");
    }
  } else {
    throw new UnsafeWebhookUrlError("INVALID_PROTOCOL", `Webhook URL protocol "${url.protocol}" is not allowed — only http/https.`);
  }

  // The WHATWG `URL` parser keeps the enclosing `[...]` on an IPv6 literal
  // hostname (`new URL("https://[::1]/").hostname === "[::1]"`) — strip it
  // before any `net.isIP`/DNS-shaped check, which both expect the bare
  // address form.
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname.toLowerCase() === "localhost" && !options.allowPrivateAddresses) {
    throw new UnsafeWebhookUrlError("BLOCKED_HOST", `Webhook URL host "${hostname}" is disallowed.`);
  }

  const resolveHost = options.resolveHost ?? defaultResolveHost;
  let resolvedAddresses: ResolvedHostAddress[];
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    resolvedAddresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    try {
      resolvedAddresses = await resolveHost(hostname);
    } catch {
      throw new UnsafeWebhookUrlError("DNS_RESOLUTION_FAILED", `Could not resolve webhook host "${hostname}".`);
    }
    if (resolvedAddresses.length === 0) {
      throw new UnsafeWebhookUrlError("DNS_RESOLUTION_FAILED", `Webhook host "${hostname}" did not resolve to any address.`);
    }
  }

  if (!options.allowPrivateAddresses) {
    for (const { address } of resolvedAddresses) {
      if (isBlockedAddress(address)) {
        throw new UnsafeWebhookUrlError("BLOCKED_HOST", `Webhook URL host "${hostname}" resolves to a disallowed address (${address}).`);
      }
    }
  }

  return { hostname, resolvedAddresses };
}
