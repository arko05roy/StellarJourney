import { describe, expect, it } from "vitest";
import { UnsafeWebhookUrlError, assertSafeWebhookUrl, type HostResolver } from "./webhook-url-guard.js";

describe("assertSafeWebhookUrl", () => {
  it("accepts a public https URL with a literal public IP host (no DNS needed)", async () => {
    const info = await assertSafeWebhookUrl("https://93.184.216.34/webhooks");
    expect(info.hostname).toBe("93.184.216.34");
    expect(info.resolvedAddresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(assertSafeWebhookUrl("ftp://example.com")).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects http by default", async () => {
    await expect(assertSafeWebhookUrl("http://93.184.216.34/hook")).rejects.toMatchObject({ code: "INSECURE_PROTOCOL" });
  });

  it("allows http when explicitly opted in", async () => {
    await expect(assertSafeWebhookUrl("http://93.184.216.34/hook", { allowInsecureHttp: true })).resolves.toBeDefined();
  });

  it("rejects the literal host 'localhost'", async () => {
    await expect(assertSafeWebhookUrl("https://localhost/hook")).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
    it(`rejects loopback/private-range IPv4 literal: ${ip}`, async () => {
      await expect(assertSafeWebhookUrl(`https://${ip}/hook`)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    });
  }

  for (const ip of ["::1", "fe80::1", "fc00::1", "fd00::abcd", "::ffff:127.0.0.1"]) {
    it(`rejects loopback/private-range IPv6 literal: ${ip}`, async () => {
      await expect(assertSafeWebhookUrl(`https://[${ip}]/hook`)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    });
  }

  it("accepts a public IPv6 literal", async () => {
    // 2606:2800:220:1:248:1893:25c8:1946 — a real public (example.com-class) address.
    const info = await assertSafeWebhookUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/hook");
    expect(info.resolvedAddresses[0]?.family).toBe(6);
  });

  it("uses the injected resolver for a hostname, and rejects when it resolves to a private address", async () => {
    const resolveHost: HostResolver = async () => [{ address: "10.0.0.1", family: 4 }];
    await expect(assertSafeWebhookUrl("https://internal.example.test/hook", { resolveHost })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("uses the injected resolver for a hostname, and accepts when it resolves to a public address", async () => {
    const resolveHost: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const info = await assertSafeWebhookUrl("https://merchant.example.test/hook", { resolveHost });
    expect(info.hostname).toBe("merchant.example.test");
    expect(info.resolvedAddresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects when even one of several resolved addresses is private (DNS rebinding / multi-A-record defense)", async () => {
    const resolveHost: HostResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(assertSafeWebhookUrl("https://mixed.example.test/hook", { resolveHost })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("surfaces a resolver failure as DNS_RESOLUTION_FAILED", async () => {
    const resolveHost: HostResolver = async () => {
      throw new Error("NXDOMAIN");
    };
    await expect(assertSafeWebhookUrl("https://nowhere.example.test/hook", { resolveHost })).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED" });
  });

  it("rejects a malformed URL", async () => {
    await expect(assertSafeWebhookUrl("not-a-url")).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  it("allowPrivateAddresses bypasses the loopback/private block (test-only escape hatch)", async () => {
    const info = await assertSafeWebhookUrl("https://127.0.0.1:4000/hook", { allowPrivateAddresses: true });
    expect(info.resolvedAddresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
    const localhostInfo = await assertSafeWebhookUrl("https://localhost:4000/hook", { allowPrivateAddresses: true });
    expect(localhostInfo.hostname).toBe("localhost");
  });

  it("allowPrivateAddresses does not bypass the protocol requirement", async () => {
    await expect(assertSafeWebhookUrl("http://127.0.0.1:4000/hook", { allowPrivateAddresses: true })).rejects.toMatchObject({ code: "INSECURE_PROTOCOL" });
  });
});
