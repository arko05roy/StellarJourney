-- One Stellar account owns at most one merchant profile. Existing duplicate
-- rows must be resolved explicitly rather than silently merged.
CREATE UNIQUE INDEX "Merchant_walletAddress_key" ON "Merchant"("walletAddress");

CREATE TABLE "MerchantAuthChallenge" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "messageHash" TEXT NOT NULL,
    "networkPassphrase" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantAuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MerchantSession" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantSession_tokenHash_key" ON "MerchantSession"("tokenHash");
CREATE INDEX "MerchantAuthChallenge_walletAddress_idx" ON "MerchantAuthChallenge"("walletAddress");
CREATE INDEX "MerchantAuthChallenge_expiresAt_idx" ON "MerchantAuthChallenge"("expiresAt");
CREATE INDEX "MerchantSession_merchantId_idx" ON "MerchantSession"("merchantId");
CREATE INDEX "MerchantSession_walletAddress_idx" ON "MerchantSession"("walletAddress");
CREATE INDEX "MerchantSession_tokenPrefix_idx" ON "MerchantSession"("tokenPrefix");
CREATE INDEX "MerchantSession_expiresAt_idx" ON "MerchantSession"("expiresAt");

ALTER TABLE "MerchantSession"
ADD CONSTRAINT "MerchantSession_merchantId_fkey"
FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
