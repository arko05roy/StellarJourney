import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class ApiMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter;
  private readonly duration: Histogram;
  private readonly authRejections: Counter;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "paymap_api_" });
    this.requests = new Counter({
      name: "paymap_api_requests_total",
      help: "Completed API requests.",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: "paymap_api_request_seconds",
      help: "API request duration.",
      labelNames: ["method", "route"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.authRejections = new Counter({
      name: "paymap_api_auth_rejections_total",
      help: "Rejected API-key authentication and authorization attempts.",
      labelNames: ["reason"] as const,
      registers: [this.registry],
    });
  }

  observe(method: string, route: string, statusCode: number, durationMs: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.requests.inc({ method, route, status_class: statusClass });
    this.duration.observe({ method, route }, Math.max(0, durationMs) / 1000);
  }

  observeAuthRejection(code: string): void {
    const reason = AUTH_REJECTION_CODES.has(code) ? code : "other";
    this.authRejections.inc({ reason });
  }
}

const AUTH_REJECTION_CODES = new Set([
  "MISSING_API_KEY",
  "INVALID_API_KEY",
  "API_KEY_REVOKED",
  "MERCHANT_DISABLED",
  "INSUFFICIENT_SCOPE",
]);
