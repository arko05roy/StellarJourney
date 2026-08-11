import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ObservabilityRegistry } from "./observability.js";
import { startMetricsServer } from "./metrics-server.js";

describe("metrics server readiness", () => {
  const servers: ReturnType<typeof startMetricsServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("returns 503 when a dependency check hangs", async () => {
    const server = startMetricsServer({
      port: 0,
      observability: new ObservabilityRegistry(),
      ready: () => new Promise<void>(() => undefined),
      readyTimeoutMs: 20,
    });
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("not ready\n");
  });
});
