import { describe, expect, it } from "vitest";
import { ObservabilityRegistry } from "./observability.js";

describe("ObservabilityRegistry", () => {
  it("tracks every PLAN §21 signal with deterministic rates and per-asset volume", async () => {
    const metrics = new ObservabilityRegistry();
    metrics.setActiveMandates(7);
    metrics.recordChargeSuccess(100, "USDC", 25n);
    metrics.recordChargeSuccess(300, "USDC", 75n);
    metrics.recordChargeFailure("MandateRevoked");
    metrics.recordChargeFailure("MandateRevoked");
    metrics.recordChargeFailure("AmountExceedsPeriodLimit");
    metrics.recordSimulation(true);
    metrics.recordSimulation(false);
    metrics.recordRpcLatency(10);
    metrics.recordRpcLatency(30);
    metrics.recordWebhook(true);
    metrics.recordWebhook(false);
    metrics.recordRetry();
    metrics.recordDuplicateChargePrevented();
    metrics.recordIndexerRetentionGap();
    metrics.setStuckSubmittedCharges(2);

    expect(metrics.snapshot()).toEqual({
      activeMandates: 7,
      chargeAttempts: 5,
      successfulCharges: 2,
      successfulChargeRate: 0.4,
      failuresByReason: { MandateRevoked: 2, AmountExceedsPeriodLimit: 1 },
      failureRateByReason: { MandateRevoked: 0.4, AmountExceedsPeriodLimit: 0.2 },
      averageSettlementMs: 200,
      simulationAttempts: 2,
      simulationFailures: 1,
      simulationFailureRate: 0.5,
      rpcRequests: 2,
      averageRpcLatencyMs: 20,
      webhookAttempts: 2,
      webhookSuccesses: 1,
      webhookSuccessRate: 0.5,
      retryCount: 1,
      duplicateChargeAttemptsPrevented: 1,
      paymentVolumeByAsset: { USDC: "100" },
    });
    expect(await metrics.metrics()).toContain("paymap_indexer_retention_gaps_total 1");
    expect(await metrics.metrics()).toContain("paymap_stuck_submitted_charges 2");
  });
});
