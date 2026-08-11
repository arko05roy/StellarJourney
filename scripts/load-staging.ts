/**
 * Dependency-free, bounded staging load probe. Defaults are deliberately
 * conservative; mutating endpoints are not supported by this runner.
 */
export {};

const target = process.env["LOAD_TARGET_URL"];
if (!target) throw new Error("LOAD_TARGET_URL is required.");

const url = new URL(process.env["LOAD_PATH"] ?? "/healthz", target);
if (
  url.hostname !== "localhost" &&
  url.hostname !== "127.0.0.1" &&
  !url.hostname.endsWith(".onrender.com") &&
  process.env["LOAD_ALLOW_ANY_HOST"] !== "1"
) {
  throw new Error("Refusing load test outside localhost or *.onrender.com.");
}

const durationSeconds = Number(process.env["LOAD_DURATION_SECONDS"] ?? 30);
const concurrency = Number(process.env["LOAD_CONCURRENCY"] ?? 10);
const maxRequests = Number(process.env["LOAD_MAX_REQUESTS"] ?? 2_000);
const p95BudgetMs = Number(process.env["LOAD_P95_BUDGET_MS"] ?? 1_000);
const errorBudget = Number(process.env["LOAD_ERROR_BUDGET"] ?? 0.01);
if (
  !Number.isFinite(durationSeconds) ||
  durationSeconds <= 0 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 100 ||
  !Number.isInteger(maxRequests) ||
  maxRequests < 1 ||
  maxRequests > 100_000
) {
  throw new Error("Invalid load-test limits.");
}

const latencies: number[] = [];
let issued = 0;
let failures = 0;
const deadline = performance.now() + durationSeconds * 1000;
const headers: Record<string, string> = {};
if (process.env["LOAD_API_KEY"]) {
  headers.authorization = `Bearer ${process.env["LOAD_API_KEY"]}`;
}

async function worker(): Promise<void> {
  while (performance.now() < deadline && issued < maxRequests) {
    issued++;
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) failures++;
      await response.arrayBuffer();
    } catch {
      failures++;
    } finally {
      latencies.push(performance.now() - started);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((a, b) => a - b);

function percentile(p: number): number {
  if (latencies.length === 0) return 0;
  const index = Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1);
  return latencies[index] ?? 0;
}

const errorRate = issued === 0 ? 1 : failures / issued;
const report = {
  target: url.origin + url.pathname,
  requests: issued,
  failures,
  errorRate,
  latencyMs: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: latencies.at(-1) ?? 0,
  },
  budgets: { p95Ms: p95BudgetMs, errorRate: errorBudget },
  passed: errorRate <= errorBudget && percentile(0.95) <= p95BudgetMs,
};

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
