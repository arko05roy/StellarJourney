import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  baseUnitsToDecimalString,
  decimalToPositiveBaseUnits,
  MoneyConversionError,
} from "@paymap/shared";
import { badRequest, notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CreateProductSchema } from "../schemas/products.js";
import type { Product } from "../db.js";

const ListProductsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export function toProductResponse(product: Product) {
  const decimals = product.assetDecimals;
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? undefined,
    assetAddress: product.assetAddress,
    assetDecimals: decimals,
    amountType: product.amountType,
    fixedAmount: product.fixedAmount
      ? baseUnitsToDecimalString(BigInt(product.fixedAmount), decimals)
      : undefined,
    maxPerCharge: product.maxPerCharge
      ? baseUnitsToDecimalString(BigInt(product.maxPerCharge), decimals)
      : undefined,
    maxPerPeriod: baseUnitsToDecimalString(BigInt(product.maxPerPeriod), decimals),
    periodSeconds: product.periodSeconds,
    minIntervalSeconds: product.minIntervalSeconds,
    maxSuccessfulCharges: product.maxSuccessfulCharges,
    defaultDurationSeconds: product.defaultDurationSeconds,
    active: product.active,
    createdAt: product.createdAt.toISOString(),
  };
}

/** Converts a decimal-string amount to positive base units, mapping malformed/zero/over-precision input to a 400 (CLAUDE.md §9/§10). */
function toPositiveBaseUnitsOrBadRequest(field: string, decimal: string, decimals: number): bigint {
  try {
    return decimalToPositiveBaseUnits(decimal, decimals);
  } catch (error) {
    if (error instanceof MoneyConversionError) {
      throw badRequest("INVALID_AMOUNT", `"${field}": ${error.message}`);
    }
    throw error;
  }
}

const productsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/products",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["products:write"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const input = CreateProductSchema.parse(request.body);

      const maxPerPeriodBaseUnits = toPositiveBaseUnitsOrBadRequest(
        "maxPerPeriod",
        input.maxPerPeriod,
        input.assetDecimals,
      );
      const fixedAmountBaseUnits =
        input.amountType === "fixed"
          ? toPositiveBaseUnitsOrBadRequest("fixedAmount", input.fixedAmount, input.assetDecimals)
          : undefined;
      const maxPerChargeBaseUnits =
        input.amountType === "variable"
          ? toPositiveBaseUnitsOrBadRequest("maxPerCharge", input.maxPerCharge, input.assetDecimals)
          : undefined;

      const product = await app.prisma.product.create({
        data: {
          merchantId: merchant.id,
          name: input.name,
          description: input.description ?? null,
          assetAddress: input.assetAddress,
          assetDecimals: input.assetDecimals,
          amountType: input.amountType,
          fixedAmount: fixedAmountBaseUnits?.toString() ?? null,
          maxPerCharge: maxPerChargeBaseUnits?.toString() ?? null,
          maxPerPeriod: maxPerPeriodBaseUnits.toString(),
          periodSeconds: input.periodSeconds,
          minIntervalSeconds: input.minIntervalSeconds,
          maxSuccessfulCharges: input.maxSuccessfulCharges,
          defaultDurationSeconds: input.defaultDurationSeconds,
        },
      });

      reply.status(201).send(toProductResponse(product));
    },
  );

  /** Merchant-scoped product catalog, newest first — backs the dashboard's "Products" list (PLAN.md §16.3). */
  app.get(
    "/products",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["products:read"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const query = ListProductsQuerySchema.parse(request.query);
      const products = await app.prisma.product.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });
      reply.status(200).send({ data: products.map(toProductResponse) });
    },
  );

  app.get(
    "/products/:id",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["products:read"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const { id } = request.params as { id: string };
      const product = await app.prisma.product.findFirst({
        where: { id, merchantId: merchant.id },
      });
      if (!product) {
        throw notFoundError("PRODUCT_NOT_FOUND", `No product "${id}" for this merchant.`);
      }
      reply.status(200).send(toProductResponse(product));
    },
  );
};

export default productsRoutes;
