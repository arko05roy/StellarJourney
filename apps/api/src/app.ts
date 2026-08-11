/**
 * Fastify application factory. A factory (not a module-level singleton) so
 * tests can build an isolated instance per test file, injecting a fake
 * `MandateReader` (no real Soroban RPC in tests) and a fixed `now()` clock
 * (deterministic boundary tests for expiry/interval/period rollover)
 * alongside a real Prisma client pointed at the Postgres started by
 * `docker-compose.yml`.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";
import type { MandateReader } from "./chain/mandate-reader.js";
import type { PrismaClient } from "./db.js";
import merchantsRoutes from "./routes/merchants.js";
import productsRoutes from "./routes/products.js";
import checkoutSessionsRoutes from "./routes/checkout-sessions.js";
import mandatesRoutes from "./routes/mandates.js";
import chargesRoutes from "./routes/charges.js";
import paymentsRoutes from "./routes/payments.js";
import webhookEndpointsRoutes from "./routes/webhook-endpoints.js";
import consumerRoutes from "./routes/consumer.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    mandateReader: MandateReader;
    hashSecret: string;
    now: () => Date;
  }
}

export interface BuildAppOptions {
  prisma: PrismaClient;
  mandateReader: MandateReader;
  hashSecret: string;
  /** Injectable clock — defaults to the real wall clock. Tests use a fixed instant for deterministic boundary assertions. */
  now?: () => Date;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.decorate("prisma", options.prisma);
  app.decorate("mandateReader", options.mandateReader);
  app.decorate("hashSecret", options.hashSecret);
  app.decorate("now", options.now ?? (() => new Date()));

  // Permissive by design, not an oversight: the only routes a browser ever
  // calls cross-origin are the *unauthenticated* checkout-session endpoints
  // (Phase 10's consumer checkout page, hosted on a different origin than
  // this API) — CORS gates browser JS access, not the API's actual
  // security boundary (the bearer-token `Authorization` check every other
  // route requires), so reflecting any origin here doesn't weaken auth.
  // Merchant checkout pages are expected to live on arbitrary merchant-
  // controlled domains, so an allowlist would defeat the point.
  app.register(cors, { origin: true });

  // Generous global default; specific routes (merchant creation, API key
  // rotation, charge creation — CLAUDE.md §10) override with a stricter
  // per-route limit. IP-keyed for every route (including authenticated
  // ones) — simplest correct MVP choice; merchant-scoped limiting is a
  // documented future refinement, not required for Phase 8's scope.
  app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
    // @fastify/rate-limit does `throw errorResponseBuilder(req, context)`
    // verbatim (verified against its source) — the returned value becomes
    // the "error" our own `setErrorHandler` below receives, so it must
    // carry its own `statusCode` for that handler to recognize it (mirrors
    // the plugin's own default builder, which does the same on a plain
    // `Error`).
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: "RATE_LIMITED",
      message: `Rate limit exceeded, retry in ${String(context.after)}.`,
    }),
  });

  app.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      reply.status(error.httpStatus).send(error.toBody());
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    // @fastify/rate-limit's `errorResponseBuilder` result is `throw`n
    // verbatim (verified against its source) — it is the plain object our
    // own builder above constructs, not an `Error` instance, so it's
    // handled here by shape rather than `instanceof`.
    if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode: unknown }).statusCode === 429) {
      const { statusCode: _statusCode, ...body } = error as { statusCode: number; code: string; message: string };
      reply.status(429).send(body);
      return;
    }
    app.log.error(error);
    reply.status(500).send({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
  });

  app.register(
    async (v1) => {
      await v1.register(merchantsRoutes);
      await v1.register(productsRoutes);
      await v1.register(checkoutSessionsRoutes);
      await v1.register(mandatesRoutes);
      await v1.register(chargesRoutes);
      await v1.register(paymentsRoutes);
      await v1.register(webhookEndpointsRoutes);
      await v1.register(consumerRoutes);
    },
    { prefix: "/v1" },
  );

  return app;
}
