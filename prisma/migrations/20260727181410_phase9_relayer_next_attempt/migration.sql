-- AlterTable
ALTER TABLE "ChargeRequest" ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ChargeRequest_nextAttemptAt_idx" ON "ChargeRequest"("nextAttemptAt");
