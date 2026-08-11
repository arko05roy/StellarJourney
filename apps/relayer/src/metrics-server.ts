import { createServer, type Server } from "node:http";
import type { ObservabilityRegistry } from "./observability.js";

export interface MetricsServerOptions {
  port: number;
  observability: ObservabilityRegistry;
  ready: () => Promise<void>;
  readyTimeoutMs?: number;
}

export function startMetricsServer(options: MetricsServerOptions): Server {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok\n");
        return;
      }
      if (request.url === "/readyz") {
        try {
          const timeoutMs = options.readyTimeoutMs ?? 2_000;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              options.ready(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Readiness check timed out.")),
                  timeoutMs,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end("ready\n");
        } catch {
          response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          response.end("not ready\n");
        }
        return;
      }
      if (request.url === "/metrics") {
        response.writeHead(200, { "content-type": options.observability.contentType });
        response.end(await options.observability.metrics());
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(options.port, "0.0.0.0");
  return server;
}
