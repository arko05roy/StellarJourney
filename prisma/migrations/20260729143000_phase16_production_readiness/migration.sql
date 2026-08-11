CREATE TYPE "ChargeAuthorizationStatus" AS ENUM ('pending', 'ready', 'consumed', 'expired');

ALTER TABLE "ApiKey"
ADD COLUMN "name" TEXT NOT NULL DEFAULT 'Default',
ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[
  'products:read',
  'products:write',
  'checkout_sessions:read',
  'checkout_sessions:write',
  'mandates:read',
  'charges:read',
  'charges:write',
  'payments:read',
  'refunds:read',
  'refunds:write',
  'webhooks:read',
  'webhooks:write',
  'api_keys:manage'
]::TEXT[],
ADD COLUMN "lastUsedAt" TIMESTAMP(3);

CREATE TABLE "ChargeAuthorization" (
  "id" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL,
  "chargeId" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "invoiceHash" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "networkPassphrase" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "unsignedEntryXdr" TEXT NOT NULL,
  "signedEntryCiphertext" TEXT,
  "signatureExpirationLedger" BIGINT NOT NULL,
  "status" "ChargeAuthorizationStatus" NOT NULL DEFAULT 'pending',
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChargeAuthorization_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChargeRequest"
ADD COLUMN "authorizationId" TEXT;

CREATE UNIQUE INDEX "ChargeAuthorization_chargeId_key" ON "ChargeAuthorization"("chargeId");
CREATE INDEX "ChargeAuthorization_merchantId_idx" ON "ChargeAuthorization"("merchantId");
CREATE INDEX "ChargeAuthorization_mandateId_idx" ON "ChargeAuthorization"("mandateId");
CREATE INDEX "ChargeAuthorization_status_idx" ON "ChargeAuthorization"("status");
CREATE UNIQUE INDEX "ChargeRequest_authorizationId_key" ON "ChargeRequest"("authorizationId");

ALTER TABLE "ChargeAuthorization"
ADD CONSTRAINT "ChargeAuthorization_merchantId_fkey"
FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChargeRequest"
ADD CONSTRAINT "ChargeRequest_authorizationId_fkey"
FOREIGN KEY ("authorizationId") REFERENCES "ChargeAuthorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
