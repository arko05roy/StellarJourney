"use client";

/**
 * Orchestrates the full Phase 10 checkout flow (PLAN.md §16.2): review
 * terms -> connect wallet -> sign `create_mandate` -> sign a bounded
 * `approve` -> report the mandate back to the checkout session ->
 * confirmation. State transitions live in `lib/checkout-state.ts` (a plain,
 * independently-tested reducer); this component only wires user actions to
 * dispatches and renders the current phase.
 *
 * `wallet`/`gateway` are injected rather than constructed here so the
 * Playwright happy-path test can supply deterministic stubs (see
 * `lib/test-stubs.ts`) without a real wallet extension or Soroban RPC in
 * CI — the parent page decides which implementation to pass down.
 */
import { useCallback, useReducer } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { checkoutReducer, initialCheckoutState } from "@/lib/checkout-state";
import { toDisplayError } from "@/lib/errors";
import { randomHexId32, sha256Hex } from "@/lib/ids";
import { linkMandateToCheckoutSession, type PublicCheckoutSession } from "@/lib/api";
import { computeBoundedAllowance, computeMaxExposure, deriveMandateTerms } from "@/lib/mandate-terms";
import { formatAmount, formatAssetSymbol } from "@/lib/format";
import type { ChainGateway } from "@/lib/chain-gateway";
import type { WalletAdapter } from "@/lib/wallet";
import type { MandateInput } from "@paymap/contract-client";
import { MaxExposureCallout } from "./max-exposure-callout";
import { TermsList } from "./terms-list";
import { WalletConnectButton } from "./wallet-connect-button";
import { ErrorBanner } from "./error-banner";
import { ConfirmationCard } from "./confirmation-card";

export interface CheckoutFlowProps {
  session: PublicCheckoutSession;
  wallet: WalletAdapter;
  gateway: ChainGateway;
  mandateContractId: string;
  /** Unix seconds — passed down from the Server Component page so "now" is consistent between the terms preview and the actual `create_mandate` call. */
  nowUnixSeconds: bigint;
}

export function CheckoutFlow({ session, wallet, gateway, mandateContractId, nowUnixSeconds }: CheckoutFlowProps) {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckoutState);
  const terms = deriveMandateTerms(session.product, nowUnixSeconds);
  const maxExposure = computeMaxExposure(terms);
  const allowance = computeBoundedAllowance(maxExposure);
  const assetSymbol = formatAssetSymbol(terms.assetAddress);

  const handleConnect = useCallback(async () => {
    dispatch({ type: "CONNECT_START" });
    try {
      const { address } = await wallet.connect();
      dispatch({ type: "CONNECT_SUCCESS", address });
    } catch (error) {
      dispatch({ type: "CONNECT_ERROR", error: toDisplayError(error) });
    }
  }, [wallet]);

  const runLink = useCallback(
    async (address: string, mandateId: string) => {
      dispatch({ type: "LINK_START" });
      try {
        await linkMandateToCheckoutSession(session.id, { mandateId, payerAddress: address });
        dispatch({ type: "LINK_SUCCESS" });
      } catch (error) {
        dispatch({ type: "LINK_ERROR", error: toDisplayError(error) });
      }
    },
    [session.id],
  );

  const runApprove = useCallback(
    async (address: string, mandateId: string) => {
      dispatch({ type: "APPROVE_START" });
      try {
        const signer = { publicKey: address, signTransaction: wallet.signTransaction, signAuthEntry: wallet.signAuthEntry };
        const approveArgs = { tokenContractId: terms.assetAddress, spender: mandateContractId, mandateExpiresAt: terms.expiresAt };

        // Safer allowance-change sequence (PLAN.md §10.10): the mandate
        // contract is one shared spender across every mandate this payer
        // has ever created, so a payer opening a second/later checkout may
        // already have a non-zero allowance granted to it from an earlier
        // mandate. Setting a new absolute amount directly on top of an
        // unknown existing value is exactly the ambiguity this sequence
        // exists to avoid — zero it first, confirm the zero landed, only
        // then set the new bounded amount. Skipped entirely (no extra
        // signature requested) when there is nothing to reset, which is
        // the common case for a payer's very first mandate.
        const currentAllowance = await gateway.queryAllowance({ tokenContractId: terms.assetAddress, spender: mandateContractId }, { publicKey: address });
        if (currentAllowance > 0n) {
          await gateway.approve({ ...approveArgs, amount: 0n }, signer);
          const confirmedZero = await gateway.queryAllowance({ tokenContractId: terms.assetAddress, spender: mandateContractId }, { publicKey: address });
          if (confirmedZero !== 0n) {
            throw new Error("failed to reset the previous spending approval to zero before setting the new one");
          }
        }

        await gateway.approve({ ...approveArgs, amount: allowance.total }, signer);
        dispatch({ type: "APPROVE_SUCCESS" });
        await runLink(address, mandateId);
      } catch (error) {
        dispatch({ type: "APPROVE_ERROR", error: toDisplayError(error) });
      }
    },
    [gateway, terms.assetAddress, terms.expiresAt, mandateContractId, allowance.total, runLink, wallet],
  );

  const handleCreateMandate = useCallback(
    async (address: string) => {
      dispatch({ type: "CREATE_MANDATE_START" });
      try {
        const clientNonce = randomHexId32();
        const metadataHash = await sha256Hex(`${session.merchant.walletAddress}:${session.product.id}:${session.id}`);
        const input: MandateInput = {
          payer: address,
          merchant: session.merchant.walletAddress,
          asset: terms.assetAddress,
          amountRule: terms.amountRule,
          maxPerPeriod: terms.maxPerPeriod,
          periodSeconds: terms.periodSeconds,
          minIntervalSeconds: terms.minIntervalSeconds,
          startAt: terms.startAt,
          expiresAt: terms.expiresAt,
          maxSuccessfulCharges: terms.maxSuccessfulCharges,
          metadataHash,
          clientNonce,
        };
        const { mandateId } = await gateway.createMandate(input, {
          publicKey: address,
          signTransaction: wallet.signTransaction,
          signAuthEntry: wallet.signAuthEntry,
        });
        dispatch({ type: "CREATE_MANDATE_SUCCESS", mandateId });
        await runApprove(address, mandateId);
      } catch (error) {
        dispatch({ type: "CREATE_MANDATE_ERROR", error: toDisplayError(error) });
      }
    },
    [gateway, session, terms, runApprove, wallet],
  );

  const handleRetryApprove = useCallback(() => {
    if (state.address && state.mandateId) {
      void runApprove(state.address, state.mandateId);
    }
  }, [state.address, state.mandateId, runApprove]);

  const handleRetryLink = useCallback(() => {
    if (state.address && state.mandateId) {
      void runLink(state.address, state.mandateId);
    }
  }, [state.address, state.mandateId, runLink]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{session.merchant.name}</h1>
        <p className="text-sm text-muted-foreground">{session.product.name}</p>
        {session.product.description ? <p className="mt-1 text-sm text-muted-foreground">{session.product.description}</p> : null}
      </div>

      <MaxExposureCallout maxExposureBaseUnits={maxExposure} assetDecimals={terms.assetDecimals} assetSymbol={assetSymbol} />

      <div>
        <h2 className="mb-1 text-sm font-medium text-foreground">Terms of this automatic payment</h2>
        <TermsList merchantName={session.merchant.name} productName={session.product.name} assetSymbol={assetSymbol} terms={terms} />
      </div>

      <Separator />

      {state.phase === "complete" ? (
        <div className="flex flex-col gap-3">
          <ConfirmationCard
            mandateId={state.mandateId ?? ""}
            merchantName={session.merchant.name}
            terms={terms}
            assetSymbol={assetSymbol}
            allowanceTotal={allowance.total}
          />
          {state.linkWarning ? (
            <ErrorBanner error={state.linkWarning} onRetry={state.mandateId ? handleRetryLink : undefined} retryLabel="Retry saving to merchant" />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="signing-panel">
          <div className="rounded-lg border border-foreground/15 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            You will be asked to approve a spending limit of{" "}
            <span className="font-medium text-foreground">
              {formatAmount(allowance.total, terms.assetDecimals)} {assetSymbol}
            </span>{" "}
            (the maximum exposure above, plus a small 1% buffer). This amount is never unlimited, and you can lower it to zero at any time
            from your payment dashboard.
          </div>

          {state.phase === "idle" || state.phase === "connecting" ? (
            <WalletConnectButton connecting={state.phase === "connecting"} onConnect={handleConnect} />
          ) : null}

          {state.phase === "ready" ? (
            <Button type="button" size="lg" className="w-full" onClick={() => void handleCreateMandate(state.address ?? "")} data-testid="authorize-button">
              Authorize automatic payment
            </Button>
          ) : null}

          {state.phase === "creating-mandate" ? (
            <Button type="button" size="lg" className="w-full" disabled data-testid="creating-indicator">
              Waiting for your signature…
            </Button>
          ) : null}

          {state.phase === "approving" || state.phase === "linking" ? (
            <Button type="button" size="lg" className="w-full" disabled data-testid="approving-indicator">
              {state.phase === "approving" ? "Waiting for your approval signature…" : "Finishing setup…"}
            </Button>
          ) : null}

          {state.phase === "error" && state.error ? (
            <div className="flex flex-col gap-3">
              <ErrorBanner
                error={state.error}
                onRetry={state.failedStep === "connect" ? () => void handleConnect() : undefined}
              />
              {state.failedStep === "approve" && state.mandateId ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" data-testid="unfunded-mandate-notice">
                  <p className="font-medium text-foreground">Your automatic payment was created, but is not funded yet.</p>
                  <p className="mt-1 text-muted-foreground">
                    The automatic payment itself exists on-chain, but the spending approval step did not complete. No money can move
                    until you finish this step.
                  </p>
                  <Button type="button" className="mt-3" onClick={handleRetryApprove} data-testid="complete-approval-button">
                    Complete the approval
                  </Button>
                </div>
              ) : null}
              {state.failedStep === "create-mandate" ? (
                <Button type="button" size="lg" className="w-full" onClick={() => void handleCreateMandate(state.address ?? "")}>
                  Try authorizing again
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
