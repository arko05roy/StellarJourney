/**
 * The relayer's worker pipeline (CLAUDE.md §11, PLAN.md §15), run once per
 * `ChargeRequest`. Reuses `apps/api/src/state-machine.ts`'s guard/transition
 * helper verbatim (not re-implemented) — the only change this phase makes
 * to that shared table is the `retryable_failed -> processing` edge it adds
 * for the scheduler's retry re-entry.
 *
 * Order of operations, matching CLAUDE.md §11 exactly:
 *   1. Claim: guarded DB transition `scheduled|retryable_failed -> processing`.
 *      A concurrent caller that loses this race returns
 *      `skipped_not_claimable` having made zero chain calls — this, not
 *      BullMQ's own job locking, is what guarantees at most one successful
 *      charge under duplicate job delivery (decision #2).
 *   2. Load fresh on-chain mandate state (never the DB's `MandateIndex`
 *      cache — CLAUDE.md §2).
 *   3. Build the invocation (`ChainGateway.prepareCharge`, which also
 *      simulates as part of construction).
 *   4. (simulation already happened in step 3 — `AssembledTransaction`
 *      simulates on construction.)
 *   5. Verify merchant / amount / asset / charge_id / mandate_id from the
 *      *simulated* receipt against what the `ChargeRequest` + its owning
 *      `Merchant`/`Product` say (decision #3). A rejected simulation is
 *      classified via the frozen contract-error table before ever asking
 *      for a signature; a verification *mismatch* (the simulation succeeded
 *      but disagrees with the request) is a hard failure, never a retry —
 *      this is the concrete proof that a relayer cannot alter amount or
 *      destination and have it accepted.
 *   6. Transition `processing -> simulated -> submitted`, submit once.
 *   7. `ChainGateway.submit()` polls to a final on-chain result internally
 *      (the SDK's `SentTransaction.send()` already does this — see
 *      `chain-gateway.ts`'s module doc).
 *   8. On success: write the `Payment` row from the *confirmed* receipt
 *      (never optimism) and the `succeeded` transition atomically, in one
 *      DB transaction.
 *   9. On failure: classify -> `retryable_failed` (with the next attempt
 *      time) or `permanently_failed`.
 *   10. Either way, enqueue the corresponding `WebhookDelivery` row
 *       (`pending` — delivery itself is Phase 12), atomically with the
 *       terminal transition.
 */
import { transitionChargeRequest } from "@paymap/api/dist/state-machine.js";
import { ApiError } from "@paymap/api/dist/errors.js";
import { MandateReadError } from "@paymap/contract-client";
import type { ChargeRequestStatus, PrismaClient } from "./db.js";
import type { ChainGateway } from "./chain-gateway.js";
import {
  classifyContractErrorName,
  UnclassifiableContractError,
  type ClassifiedFailure,
} from "./classify.js";
import { resolveChargeContext, ChargeContextError } from "./context.js";
import { nextRetryAt } from "./retry-schedule.js";
import { enqueueChargeWebhook } from "./webhook.js";
import { decryptChargeAuthorization } from "@paymap/shared";
import { noopObservability, type Observability } from "./observability.js";

export type Logger = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => void;
const noopLogger: Logger = () => undefined;

export interface PipelineDeps {
  prisma: PrismaClient;
  gateway: ChainGateway;
  now: () => Date;
  logger?: Logger;
  observability?: Observability;
  authorizationEncryptionKey?: string;
}

export type PipelineOutcome =
  | { kind: "skipped_not_claimable" }
  | { kind: "succeeded"; paymentId: string; txHash: string }
  | { kind: "retry_scheduled"; nextAttemptAt: Date; reason: string }
  | { kind: "permanently_failed"; reason: string };

const MANUAL_REASON = {
  chargeContextNotFound: "CHARGE_CONTEXT_NOT_FOUND",
  simulationMismatch: "SIMULATION_MISMATCH",
} as const;

/** Reasons that are never contract-error codes — always a permanent, hard failure (never routed through the retry schedule). */
function permanentReason(reason: string): ClassifiedFailure {
  return { failureClass: "permanent", reason };
}

export async function processChargeRequest(
  deps: PipelineDeps,
  chargeRequestId: string,
): Promise<PipelineOutcome> {
  const { prisma, gateway, now } = deps;
  const log = deps.logger ?? noopLogger;
  const metrics = deps.observability ?? noopObservability;

  const maybeChargeRequest = await prisma.chargeRequest.findUnique({
    where: { id: chargeRequestId },
  });
  if (!maybeChargeRequest) {
    throw new Error(`ChargeRequest "${chargeRequestId}" does not exist.`);
  }
  // Re-bound as a fresh `const` so its non-null type is retained inside the
  // `fail` closure below (TS widens a null-checked outer binding back to
  // its full type across a nested function boundary).
  const chargeRequest = maybeChargeRequest;
  const logContext = {
    requestId: chargeRequestId,
    merchantId: chargeRequest.merchantId,
    mandateId: chargeRequest.mandateId,
    chargeId: chargeRequest.chargeId,
  };
  let submittedTransactionHash = chargeRequest.transactionHash ?? undefined;

  const claimFrom: ChargeRequestStatus =
    chargeRequest.status === "retryable_failed" ? "retryable_failed" : "scheduled";
  const attemptCount = chargeRequest.attemptCount + 1;
  try {
    await transitionChargeRequest(prisma, chargeRequestId, claimFrom, "processing", {
      attemptCount,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "InvalidStateTransition") {
      metrics.recordDuplicateChargePrevented();
      log("info", "charge_request.claim_lost", {
        ...logContext,
        chargeRequestId,
        attemptedFrom: claimFrom,
      });
      return { kind: "skipped_not_claimable" };
    }
    throw error;
  }
  log("info", "charge_request.claimed", { ...logContext, chargeRequestId, attemptCount });

  /** Terminal-failure path: classifies, transitions from `from`, and enqueues `payment.failed` — all in one DB transaction. */
  async function fail(
    from: ChargeRequestStatus,
    classified: ClassifiedFailure,
  ): Promise<PipelineOutcome> {
    metrics.recordChargeFailure(classified.reason);
    const retryAt =
      classified.failureClass === "transient" ? nextRetryAt(attemptCount, now()) : undefined;
    if (retryAt !== undefined) {
      metrics.recordRetry();
      await transitionChargeRequest(prisma, chargeRequestId, from, "retryable_failed", {
        failureCode: classified.reason,
        nextAttemptAt: retryAt,
      });
      log("warn", "charge_request.retry_scheduled", {
        ...logContext,
        chargeRequestId,
        reason: classified.reason,
        nextAttemptAt: retryAt.toISOString(),
      });
      return { kind: "retry_scheduled", nextAttemptAt: retryAt, reason: classified.reason };
    }

    await prisma.$transaction(async (tx) => {
      await transitionChargeRequest(tx, chargeRequestId, from, "permanently_failed", {
        failureCode: classified.reason,
        nextAttemptAt: null,
      });
      await enqueueChargeWebhook(tx, {
        merchantId: chargeRequest.merchantId,
        eventType: "payment.failed",
        payload: {
          chargeRequestId,
          mandateId: chargeRequest.mandateId,
          chargeId: chargeRequest.chargeId,
          reason: classified.reason,
        },
      });
    });
    log("error", "charge_request.permanently_failed", {
      ...logContext,
      chargeRequestId,
      reason: classified.reason,
      ...(submittedTransactionHash ? { transactionHash: submittedTransactionHash } : {}),
    });
    return { kind: "permanently_failed", reason: classified.reason };
  }

  // Step 2: fresh on-chain mandate read.
  let mandate;
  const mandateReadStartedAt = performance.now();
  try {
    mandate = await gateway.getMandate(chargeRequest.mandateId);
  } catch (error) {
    if (error instanceof MandateReadError) {
      return fail("processing", classifyContractErrorName(error.errorName));
    }
    log("warn", "charge_request.mandate_read_infrastructure_failure", {
      ...logContext,
      chargeRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("processing", {
      failureClass: "transient",
      reason: "RPC_UNAVAILABLE",
    });
  } finally {
    metrics.recordRpcLatency(performance.now() - mandateReadStartedAt);
  }

  let context;
  try {
    context = await resolveChargeContext(prisma, chargeRequest.merchantId, chargeRequest.mandateId);
  } catch (error) {
    if (error instanceof ChargeContextError) {
      return fail("processing", permanentReason(MANUAL_REASON.chargeContextNotFound));
    }
    throw error;
  }

  if (context.merchantWalletAddress !== mandate.merchant) {
    // The mandate's own merchant no longer matches what this merchant's
    // records say it should be (e.g. a data-integrity bug, or the mandate
    // id was somehow associated with the wrong merchant). Refuse to
    // proceed — never trust that the merchant on the request is the
    // merchant on the mandate.
    return fail("processing", permanentReason(MANUAL_REASON.simulationMismatch));
  }

  // Steps 3-4: build + simulate.
  const simulationStartedAt = performance.now();
  let signedAuthorizationEntryXdr: string | undefined;
  if (chargeRequest.authorizationId !== null) {
    const authorization = await prisma.chargeAuthorization.findUnique({
      where: { id: chargeRequest.authorizationId },
    });
    if (
      !authorization ||
      authorization.status !== "ready" ||
      authorization.signedEntryCiphertext === null ||
      !deps.authorizationEncryptionKey
    ) {
      return fail("processing", permanentReason("MERCHANT_AUTHORIZATION_MISSING"));
    }
    if (gateway.getLatestLedgerSequence) {
      let latestLedger: number;
      try {
        latestLedger = await gateway.getLatestLedgerSequence();
      } catch (error) {
        log("warn", "charge_request.ledger_read_infrastructure_failure", {
          ...logContext,
          chargeRequestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return fail("processing", {
          failureClass: "transient",
          reason: "RPC_UNAVAILABLE",
        });
      }
      if (BigInt(authorization.signatureExpirationLedger) <= BigInt(latestLedger)) {
        await prisma.chargeAuthorization.update({
          where: { id: authorization.id },
          data: { status: "expired" },
        });
        return fail("processing", permanentReason("MERCHANT_AUTHORIZATION_EXPIRED"));
      }
    }
    try {
      signedAuthorizationEntryXdr = decryptChargeAuthorization(
        authorization.signedEntryCiphertext,
        deps.authorizationEncryptionKey,
      );
    } catch {
      return fail("processing", permanentReason("MERCHANT_AUTHORIZATION_INVALID"));
    }
  }

  let prepared;
  try {
    prepared = await gateway.prepareCharge({
      mandateId: chargeRequest.mandateId,
      chargeId: chargeRequest.chargeId,
      amount: BigInt(chargeRequest.amount),
      invoiceHash: chargeRequest.invoiceHash,
      ...(signedAuthorizationEntryXdr ? { signedAuthorizationEntryXdr } : {}),
    });
  } catch (error) {
    log("warn", "charge_request.simulation_infrastructure_failure", {
      ...logContext,
      chargeRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("processing", {
      failureClass: "transient",
      reason: "RPC_UNAVAILABLE",
    });
  } finally {
    metrics.recordRpcLatency(performance.now() - simulationStartedAt);
  }

  if (!prepared.simulated.ok) {
    metrics.recordSimulation(false);
    let classified: ClassifiedFailure;
    try {
      classified = classifyContractErrorName(prepared.simulated.error.info.name);
    } catch (error) {
      if (error instanceof UnclassifiableContractError) {
        log("error", "charge_request.unclassifiable_contract_error", {
          ...logContext,
          chargeRequestId,
          name: prepared.simulated.error.info.name,
        });
      }
      throw error;
    }
    return fail("processing", classified);
  }
  metrics.recordSimulation(true);

  // Step 5: verify the simulation matches the request — merchant, amount,
  // asset, charge_id, and mandate_id must all agree with fresh on-chain
  // state and this merchant's own records. Any mismatch is a hard failure,
  // never a retry (decision #3) — this is the concrete proof that neither a
  // buggy nor a malicious relayer process can make a different charge
  // succeed than the one the merchant's request actually described.
  const { receipt } = prepared.simulated;
  const expectedAmount = BigInt(chargeRequest.amount);
  const verificationOk =
    receipt.merchant === context.merchantWalletAddress &&
    receipt.asset === context.expectedAssetAddress &&
    receipt.amount === expectedAmount &&
    receipt.chargeId === chargeRequest.chargeId &&
    receipt.mandateId === chargeRequest.mandateId &&
    receipt.invoiceHash === chargeRequest.invoiceHash;

  if (!verificationOk) {
    log("error", "charge_request.simulation_mismatch", {
      ...logContext,
      chargeRequestId,
      expected: {
        merchant: context.merchantWalletAddress,
        asset: context.expectedAssetAddress,
        amount: expectedAmount.toString(),
      },
      simulated: {
        merchant: receipt.merchant,
        asset: receipt.asset,
        amount: receipt.amount.toString(),
      },
    });
    return fail("processing", permanentReason(MANUAL_REASON.simulationMismatch));
  }

  // Step 6: transition through simulated -> submitted, then submit once.
  await transitionChargeRequest(prisma, chargeRequestId, "processing", "simulated");
  await transitionChargeRequest(prisma, chargeRequestId, "simulated", "submitted");

  // Step 7: `submit()` polls to a final on-chain result internally.
  const submissionStartedAt = performance.now();
  const result = await prepared.submit().finally(() => {
    metrics.recordRpcLatency(performance.now() - submissionStartedAt);
  });

  if (result.kind === "success") {
    const paymentId = result.receipt.paymentId;
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          paymentId,
          merchantId: chargeRequest.merchantId,
          mandateId: chargeRequest.mandateId,
          chargeId: chargeRequest.chargeId,
          chargeRequestId: chargeRequest.id,
          amount: result.receipt.amount.toString(),
          assetAddress: result.receipt.asset,
          transactionHash: result.txHash,
          ledger: result.ledger,
        },
      });
      await transitionChargeRequest(tx, chargeRequestId, "submitted", "succeeded", {
        transactionHash: result.txHash,
      });
      if (chargeRequest.authorizationId) {
        await tx.chargeAuthorization.update({
          where: { id: chargeRequest.authorizationId },
          data: { status: "consumed", consumedAt: now() },
        });
      }
      await enqueueChargeWebhook(tx, {
        merchantId: chargeRequest.merchantId,
        eventType: "payment.succeeded",
        payload: {
          chargeRequestId,
          paymentId,
          mandateId: chargeRequest.mandateId,
          chargeId: chargeRequest.chargeId,
          transactionHash: result.txHash,
        },
      });
      // `mandate.completed` producer: no on-chain event indexer exists in
      // this codebase (see this module's own doc history and
      // `docs/merchant-api.md`'s "webhook event producers" section), so
      // this is the *only* place a completion can be detected without one —
      // the relayer already holds the pre-charge `mandate` (step 2, fresh
      // on-chain read) with its `successfulCharges`/`maxSuccessfulCharges`.
      // `create_mandate`'s own validation (contracts/mandate-registry) never
      // allows a charge that would exceed `max_successful_charges`, so a
      // successful charge that brings the count to exactly the max is
      // deterministically the one that flips the mandate to `Completed`.
      // `maxSuccessfulCharges === 0` means "unlimited" (PLAN.md §10.8) —
      // never completes on count alone.
      if (
        mandate.maxSuccessfulCharges > 0 &&
        mandate.successfulCharges + 1 === mandate.maxSuccessfulCharges
      ) {
        await enqueueChargeWebhook(tx, {
          merchantId: chargeRequest.merchantId,
          eventType: "mandate.completed",
          payload: { mandateId: chargeRequest.mandateId },
        });
      }
    });
    metrics.recordChargeSuccess(
      Math.max(0, now().getTime() - chargeRequest.createdAt.getTime()),
      result.receipt.asset,
      result.receipt.amount,
    );
    log("info", "charge_request.succeeded", {
      ...logContext,
      chargeRequestId,
      paymentId,
      transactionHash: result.txHash,
    });
    return { kind: "succeeded", paymentId, txHash: result.txHash };
  }

  if (result.kind === "contract_error") {
    if (result.txHash !== undefined) {
      submittedTransactionHash = result.txHash;
      await prisma.chargeRequest.update({
        where: { id: chargeRequestId },
        data: { transactionHash: result.txHash },
      });
    }
    let classified: ClassifiedFailure;
    try {
      classified = classifyContractErrorName(result.error.info.name);
    } catch (error) {
      if (error instanceof UnclassifiableContractError) {
        log("error", "charge_request.unclassifiable_contract_error", {
          ...logContext,
          chargeRequestId,
          ...(result.txHash ? { transactionHash: result.txHash } : {}),
          name: result.error.info.name,
        });
      }
      throw error;
    }
    return fail("submitted", classified);
  }

  // infra_error
  log("warn", "charge_request.submission_infrastructure_failure", {
    ...logContext,
    chargeRequestId,
    reason: result.failure.reason,
    error: result.message,
  });
  return fail("submitted", result.failure);
}
