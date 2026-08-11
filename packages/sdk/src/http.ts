/**
 * Low-level request helper shared by every resource in `client.ts`. One
 * place that builds the `Authorization` header, serializes the body,
 * attaches `Idempotency-Key`, and maps a non-2xx response to
 * {@link StellarMandatesApiError} — every resource method calls this rather
 * than re-implementing fetch/error-mapping per endpoint.
 */
import { StellarMandatesApiError, StellarMandatesNetworkError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}

interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export class HttpClient {
  private readonly options: HttpClientOptions;

  constructor(options: HttpClientOptions) {
    this.options = options;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;

    let response: Response;
    try {
      response = await this.options.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StellarMandatesNetworkError(`Request to ${method} ${path} failed: ${message}`, { cause: error });
    }

    const rawText = await response.text();
    let parsed: unknown;
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const errorBody = (typeof parsed === "object" && parsed !== null ? (parsed as ApiErrorBody) : {}) as ApiErrorBody;
      throw new StellarMandatesApiError(
        response.status,
        errorBody.code ?? "UNKNOWN_ERROR",
        errorBody.message ?? `Request to ${method} ${path} failed with HTTP ${String(response.status)}.`,
        errorBody.details,
      );
    }

    return parsed as T;
  }
}
