export interface Observability {
  setActiveMandates(count: number): void;
  recordChargeSuccess(settlementMs: number, asset: string, amount: bigint): void;
  recordChargeFailure(reason: string): void;
  recordSimulation(ok: boolean): void;
  recordRpcLatency(latencyMs: number): void;
  recordWebhook(success: boolean): void;
  recordRetry(): void;
  recordDuplicateChargePrevented(): void;
  setQueueDepth(count: number): void;
  setWebhookDeadLetters(count: number): void;
  setIndexerLagLedgers(count: number): void;
  recordIndexerRetentionGap(): void;
  setStuckSubmittedCharges(count: number): void;
}

export interface ObservabilitySnapshot {
  activeMandates: number;
  chargeAttempts: number;
  successfulCharges: number;
  successfulChargeRate: number;
  failuresByReason: Record<string, number>;
  failureRateByReason: Record<string, number>;
  averageSettlementMs: number;
  simulationAttempts: number;
  simulationFailures: number;
  simulationFailureRate: number;
  rpcRequests: number;
  averageRpcLatencyMs: number;
  webhookAttempts: number;
  webhookSuccesses: number;
  webhookSuccessRate: number;
  retryCount: number;
  duplicateChargeAttemptsPrevented: number;
  paymentVolumeByAsset: Record<string, string>;
}

export const noopObservability: Observability = {
  setActiveMandates: () => undefined,
  recordChargeSuccess: () => undefined,
  recordChargeFailure: () => undefined,
  recordSimulation: () => undefined,
  recordRpcLatency: () => undefined,
  recordWebhook: () => undefined,
  recordRetry: () => undefined,
  recordDuplicateChargePrevented: () => undefined,
  setQueueDepth: () => undefined,
  setWebhookDeadLetters: () => undefined,
  setIndexerLagLedgers: () => undefined,
  recordIndexerRetentionGap: () => undefined,
  setStuckSubmittedCharges: () => undefined,
};

/** Prometheus registry plus an in-process snapshot used by focused tests/logs. */
export class ObservabilityRegistry implements Observability {
  readonly registry: Registry;
  private readonly activeMandatesMetric: Gauge;
  private readonly chargeMetric: Counter;
  private readonly settlementMetric: Histogram;
  private readonly simulationMetric: Counter;
  private readonly rpcMetric: Histogram;
  private readonly webhookMetric: Counter;
  private readonly retryMetric: Counter;
  private readonly duplicateMetric: Counter;
  private readonly paymentVolumeMetric: Counter;
  private readonly queueDepthMetric: Gauge;
  private readonly webhookDeadLettersMetric: Gauge;
  private readonly indexerLagMetric: Gauge;
  private readonly indexerRetentionGapMetric: Counter;
  private readonly stuckSubmittedChargesMetric: Gauge;
  private activeMandates = 0;
  private successfulCharges = 0;
  private settlementTotalMs = 0;
  private readonly failuresByReason = new Map<string, number>();
  private simulationAttempts = 0;
  private simulationFailures = 0;
  private rpcRequests = 0;
  private rpcLatencyTotalMs = 0;
  private webhookAttempts = 0;
  private webhookSuccesses = 0;
  private retryCount = 0;
  private duplicateChargeAttemptsPrevented = 0;
  private readonly paymentVolumeByAsset = new Map<string, bigint>();

  constructor(registry = new Registry()) {
    this.registry = registry;
    collectDefaultMetrics({ register: registry, prefix: "paymap_relayer_" });
    this.activeMandatesMetric = new Gauge({
      name: "paymap_active_mandates",
      help: "Current active mandate count.",
      registers: [registry],
    });
    this.chargeMetric = new Counter({
      name: "paymap_charge_attempts_total",
      help: "Charge outcomes.",
      labelNames: ["outcome", "reason"] as const,
      registers: [registry],
    });
    this.settlementMetric = new Histogram({
      name: "paymap_charge_settlement_seconds",
      help: "Successful charge settlement latency.",
      buckets: [1, 2.5, 5, 10, 20, 40, 80, 160],
      registers: [registry],
    });
    this.simulationMetric = new Counter({
      name: "paymap_charge_simulations_total",
      help: "Soroban charge simulation outcomes.",
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
    this.rpcMetric = new Histogram({
      name: "paymap_rpc_request_seconds",
      help: "Soroban RPC request latency.",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    });
    this.webhookMetric = new Counter({
      name: "paymap_webhook_deliveries_total",
      help: "Webhook delivery outcomes.",
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
    this.retryMetric = new Counter({
      name: "paymap_charge_retries_total",
      help: "Charge retries scheduled.",
      registers: [registry],
    });
    this.duplicateMetric = new Counter({
      name: "paymap_duplicate_charges_prevented_total",
      help: "Duplicate charge claims rejected.",
      registers: [registry],
    });
    this.paymentVolumeMetric = new Counter({
      name: "paymap_payment_volume_base_units_total",
      help: "Confirmed payment volume in asset base units.",
      labelNames: ["asset"] as const,
      registers: [registry],
    });
    this.queueDepthMetric = new Gauge({
      name: "paymap_charge_queue_depth",
      help: "Waiting, active, and delayed charge jobs.",
      registers: [registry],
    });
    this.webhookDeadLettersMetric = new Gauge({
      name: "paymap_webhook_dead_letters",
      help: "Current dead-letter webhook delivery rows.",
      registers: [registry],
    });
    this.indexerLagMetric = new Gauge({
      name: "paymap_indexer_lag_ledgers",
      help: "Current ledger minus the durable indexer cursor.",
      registers: [registry],
    });
    this.indexerRetentionGapMetric = new Counter({
      name: "paymap_indexer_retention_gaps_total",
      help: "Indexer poll failures caused by a pruned event-retention cursor.",
      registers: [registry],
    });
    this.stuckSubmittedChargesMetric = new Gauge({
      name: "paymap_stuck_submitted_charges",
      help: "Charge requests left submitted beyond the reconciliation threshold.",
      registers: [registry],
    });
  }

  setActiveMandates(count: number): void {
    this.activeMandates = Math.max(0, Math.trunc(count));
    this.activeMandatesMetric.set(this.activeMandates);
  }

  recordChargeSuccess(settlementMs: number, asset: string, amount: bigint): void {
    this.successfulCharges++;
    this.settlementTotalMs += Math.max(0, settlementMs);
    this.paymentVolumeByAsset.set(asset, (this.paymentVolumeByAsset.get(asset) ?? 0n) + amount);
    this.chargeMetric.inc({ outcome: "success", reason: "none" });
    this.settlementMetric.observe(Math.max(0, settlementMs) / 1000);
    this.paymentVolumeMetric.inc({ asset }, Number(amount));
  }

  recordChargeFailure(reason: string): void {
    this.failuresByReason.set(reason, (this.failuresByReason.get(reason) ?? 0) + 1);
    this.chargeMetric.inc({ outcome: "failure", reason: boundedFailureReason(reason) });
  }

  recordSimulation(ok: boolean): void {
    this.simulationAttempts++;
    if (!ok) this.simulationFailures++;
    this.simulationMetric.inc({ outcome: ok ? "success" : "failure" });
  }

  recordRpcLatency(latencyMs: number): void {
    this.rpcRequests++;
    this.rpcLatencyTotalMs += Math.max(0, latencyMs);
    this.rpcMetric.observe(Math.max(0, latencyMs) / 1000);
  }

  recordWebhook(success: boolean): void {
    this.webhookAttempts++;
    if (success) this.webhookSuccesses++;
    this.webhookMetric.inc({ outcome: success ? "success" : "failure" });
  }

  recordRetry(): void {
    this.retryCount++;
    this.retryMetric.inc();
  }

  recordDuplicateChargePrevented(): void {
    this.duplicateChargeAttemptsPrevented++;
    this.duplicateMetric.inc();
  }

  setQueueDepth(count: number): void {
    this.queueDepthMetric.set(Math.max(0, Math.trunc(count)));
  }

  setWebhookDeadLetters(count: number): void {
    this.webhookDeadLettersMetric.set(Math.max(0, Math.trunc(count)));
  }

  setIndexerLagLedgers(count: number): void {
    this.indexerLagMetric.set(Math.max(0, Math.trunc(count)));
  }

  recordIndexerRetentionGap(): void {
    this.indexerRetentionGapMetric.inc();
  }

  setStuckSubmittedCharges(count: number): void {
    this.stuckSubmittedChargesMetric.set(Math.max(0, Math.trunc(count)));
  }

  snapshot(): ObservabilitySnapshot {
    const failureCount = [...this.failuresByReason.values()].reduce((sum, value) => sum + value, 0);
    const chargeAttempts = this.successfulCharges + failureCount;
    const failuresByReason = Object.fromEntries(this.failuresByReason);
    return {
      activeMandates: this.activeMandates,
      chargeAttempts,
      successfulCharges: this.successfulCharges,
      successfulChargeRate: ratio(this.successfulCharges, chargeAttempts),
      failuresByReason,
      failureRateByReason: Object.fromEntries(
        Object.entries(failuresByReason).map(([reason, count]) => [
          reason,
          ratio(count, chargeAttempts),
        ]),
      ),
      averageSettlementMs: average(this.settlementTotalMs, this.successfulCharges),
      simulationAttempts: this.simulationAttempts,
      simulationFailures: this.simulationFailures,
      simulationFailureRate: ratio(this.simulationFailures, this.simulationAttempts),
      rpcRequests: this.rpcRequests,
      averageRpcLatencyMs: average(this.rpcLatencyTotalMs, this.rpcRequests),
      webhookAttempts: this.webhookAttempts,
      webhookSuccesses: this.webhookSuccesses,
      webhookSuccessRate: ratio(this.webhookSuccesses, this.webhookAttempts),
      retryCount: this.retryCount,
      duplicateChargeAttemptsPrevented: this.duplicateChargeAttemptsPrevented,
      paymentVolumeByAsset: Object.fromEntries(
        [...this.paymentVolumeByAsset].map(([asset, amount]) => [asset, amount.toString()]),
      ),
    };
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

const KNOWN_FAILURE_REASONS = new Set([
  "MandateNotFound",
  "MandateNotActive",
  "MandatePaused",
  "MandateRevoked",
  "MandateCompleted",
  "MandateExpired",
  "ChargeBeforeStart",
  "ChargeTooSoon",
  "InvalidAmount",
  "AmountExceedsChargeLimit",
  "AmountExceedsPeriodLimit",
  "ChargeCountExceeded",
  "DuplicateCharge",
  "UnauthorizedMerchant",
  "InsufficientAllowance",
  "InsufficientBalance",
  "ArithmeticOverflow",
  "InvalidMandateInput",
  "InvalidStateTransition",
  "RPC_UNAVAILABLE",
  "TX_NOT_INCLUDED",
  "SEND_FAILED",
  "CHARGE_CONTEXT_NOT_FOUND",
  "SIMULATION_MISMATCH",
  "MERCHANT_AUTHORIZATION_MISSING",
  "MERCHANT_AUTHORIZATION_EXPIRED",
  "MERCHANT_AUTHORIZATION_INVALID",
  "WORKER_INTERRUPTED",
]);

function boundedFailureReason(reason: string): string {
  return KNOWN_FAILURE_REASONS.has(reason) ? reason : "other";
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : total / count;
}
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
