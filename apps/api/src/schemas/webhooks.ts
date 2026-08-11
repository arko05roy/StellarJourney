/**
 * Webhook event payload shapes (PLAN.md §14, CLAUDE.md §12). Phase 8 defines
 * the shape and creates `WebhookDelivery` rows in `pending`; it does not
 * build the delivery worker (that's Phase 12) or sign/send anything over
 * the network yet.
 */
import { z } from "zod";
import { WebhookUrlSchema } from "./common.js";

export const WEBHOOK_EVENT_TYPES = [
  "mandate.active",
  "mandate.paused",
  "mandate.resumed",
  "mandate.revoked",
  "mandate.completed",
  "payment.succeeded",
  "payment.failed",
  "refund.succeeded",
  // Not a real product event — used only by `POST /v1/webhook-endpoints/test`.
  "webhook.test",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The envelope every delivered webhook shares (CLAUDE.md §12: event id, timestamp, signature version — signing itself is Phase 12). */
export interface WebhookEventEnvelope<TData = unknown> {
  eventId: string;
  eventType: WebhookEventType;
  createdAt: string;
  signatureVersion: "v1";
  data: TData;
}

export const WebhookEndpointTestSchema = z.object({
  url: WebhookUrlSchema,
});
export type WebhookEndpointTestInput = z.infer<typeof WebhookEndpointTestSchema>;

/** `POST /v1/webhook-endpoints` (Phase 12a) — registers/rotates the merchant's real delivery endpoint. Format-only here; the SSRF/private-range check (`@paymap/shared`'s `assertSafeWebhookUrl`) runs in the route handler, since it's async (DNS resolution) and Zod schemas must stay synchronous. */
export const RegisterWebhookEndpointSchema = z.object({
  url: WebhookUrlSchema,
});
export type RegisterWebhookEndpointInput = z.infer<typeof RegisterWebhookEndpointSchema>;
