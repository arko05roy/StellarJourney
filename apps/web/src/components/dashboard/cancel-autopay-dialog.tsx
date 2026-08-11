"use client";

/**
 * "Cancel autopay" (revoke) + the mandatory post-revoke allowance-to-zero
 * prompt (PLAN.md §10.9, the lead's decision #3). Revocation itself
 * (`CONFIRM_REVOKE` -> `gateway.revokeMandate`) is unconditional the moment
 * it's signed — nothing here can make it conditional or reversible. What
 * follows is purely about the *separate* standing risk of a lingering token
 * allowance, explained plainly, with declining always being a legitimate,
 * first-class outcome (`SKIP_ALLOWANCE`).
 *
 * All chain interaction lives in this component's `useEffect`s, driven by
 * `lib/revoke-flow.ts`'s pure reducer — the reducer decides *what* state
 * comes next, this component decides *when* to actually call the gateway.
 */
import { useCallback, useEffect, useReducer } from "react";
import { AlertTriangle, CheckCircle2, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/checkout/error-banner";
import { toDisplayError } from "@/lib/errors";
import { initialRevokeFlowState, revokeFlowReducer } from "@/lib/revoke-flow";
import type { MandateGateway, MandateSigner } from "@/lib/mandate-gateway";

export interface CancelAutopayDialogProps {
  /** `undefined` closes the dialog entirely. */
  mandateId: string | undefined;
  tokenContractId: string;
  mandateExpiresAt: bigint;
  assetSymbol: string;
  mandateContractId: string;
  gateway: MandateGateway;
  signer: MandateSigner;
  onClose: () => void;
  /** Called the moment `revoke_mandate` itself confirms — before the allowance step even starts — so the parent can refresh this mandate's live status immediately (revocation is unconditional and immediate, PLAN.md §10.9). */
  onRevoked: (mandateId: string) => void;
}

export function CancelAutopayDialog({
  mandateId,
  tokenContractId,
  mandateExpiresAt,
  assetSymbol,
  mandateContractId,
  gateway,
  signer,
  onClose,
  onRevoked,
}: CancelAutopayDialogProps) {
  const [state, dispatch] = useReducer(revokeFlowReducer, initialRevokeFlowState);
  const open = mandateId !== undefined;

  // Opens the confirmation step the moment a target mandate is set.
  useEffect(() => {
    if (open && state.phase === "idle") {
      dispatch({ type: "OPEN_CONFIRM" });
    }
  }, [open, state.phase]);

  // Drives the actual chain calls for each phase that requires one.
  useEffect(() => {
    if (!mandateId) return;

    if (state.phase === "revoking") {
      gateway
        .revokeMandate(mandateId, signer)
        .then(() => {
          onRevoked(mandateId);
          dispatch({ type: "REVOKE_SUCCESS" });
        })
        .catch((error: unknown) => dispatch({ type: "REVOKE_ERROR", error: toDisplayError(error) }));
      return;
    }

    if (state.phase === "checking-allowance") {
      gateway
        .queryAllowance({ tokenContractId, spender: mandateContractId }, signer)
        .then((allowance) => dispatch({ type: "CHECK_ALLOWANCE_RESULT", allowance }))
        .catch((error: unknown) => dispatch({ type: "ZERO_ALLOWANCE_ERROR", error: toDisplayError(error) }));
      return;
    }

    if (state.phase === "zeroing-allowance") {
      gateway
        .approve({ tokenContractId, spender: mandateContractId, amount: 0n, mandateExpiresAt }, signer)
        .then(() => dispatch({ type: "ZERO_ALLOWANCE_SUCCESS" }))
        .catch((error: unknown) => dispatch({ type: "ZERO_ALLOWANCE_ERROR", error: toDisplayError(error) }));
    }
    // Deliberately keyed on `state.phase`/`mandateId` alone, not every
    // captured value (`gateway`/`signer`/`onRevoked`/asset fields): several
    // of the parent's props are fresh object/function literals on every
    // render (see `dashboard-shell.tsx`), and this effect must fire exactly
    // once per phase transition — re-running it because a callback's
    // *identity* changed, while the phase itself hasn't, would re-submit
    // the same signed transaction.
  }, [state.phase, mandateId]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) return;
      // CLOSE is illegal mid-signature (see revoke-flow.ts) — swallow the
      // dismiss request rather than throwing from an event handler.
      if (state.phase === "confirming" || state.phase === "complete" || state.phase === "revoke-error" || state.phase === "zero-allowance-error") {
        dispatch({ type: "CLOSE" });
        onClose();
      }
    },
    [state.phase, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="cancel-autopay-dialog">
        {state.phase === "confirming" ? (
          <>
            <DialogHeader>
              <AlertTriangle className="text-destructive" />
              <DialogTitle>Cancel this automatic payment?</DialogTitle>
              <DialogDescription>
                This stops every future charge immediately. It cannot be undone, and does not require the merchant's approval.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Keep it
              </Button>
              <Button type="button" variant="destructive" onClick={() => dispatch({ type: "CONFIRM_REVOKE" })} data-testid="confirm-cancel-autopay-button">
                Cancel autopay
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {state.phase === "revoking" ? (
          <>
            <DialogHeader>
              <DialogTitle>Cancelling…</DialogTitle>
              <DialogDescription>Waiting for your wallet signature.</DialogDescription>
            </DialogHeader>
          </>
        ) : null}

        {state.phase === "revoke-error" && state.error ? (
          <>
            <DialogHeader>
              <DialogTitle>We couldn't cancel this automatic payment</DialogTitle>
            </DialogHeader>
            <ErrorBanner error={state.error} onRetry={() => dispatch({ type: "CONFIRM_REVOKE" })} retryLabel="Try again" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {state.phase === "checking-allowance" ? (
          <DialogHeader>
            <DialogTitle>Automatic payment cancelled</DialogTitle>
            <DialogDescription>Checking your spending approval…</DialogDescription>
          </DialogHeader>
        ) : null}

        {state.phase === "allowance-prompt" ? (
          <>
            <DialogHeader>
              <ShieldOff className="text-foreground" />
              <DialogTitle>Set your spending approval to zero?</DialogTitle>
              <DialogDescription>
                Your automatic payment is cancelled, so this merchant can no longer be charged. But your wallet still has an approved
                spending limit in {assetSymbol} left over from this mandate. Setting it to zero removes that standing approval entirely,
                as an extra precaution.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => dispatch({ type: "SKIP_ALLOWANCE" })} data-testid="skip-allowance-zero-button">
                Skip for now
              </Button>
              <Button type="button" onClick={() => dispatch({ type: "CONFIRM_ZERO_ALLOWANCE" })} data-testid="set-allowance-zero-button">
                Set to zero
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {state.phase === "zeroing-allowance" ? (
          <DialogHeader>
            <DialogTitle>Setting your spending approval to zero…</DialogTitle>
            <DialogDescription>Waiting for your wallet signature.</DialogDescription>
          </DialogHeader>
        ) : null}

        {state.phase === "zero-allowance-error" && state.error ? (
          <>
            <DialogHeader>
              <DialogTitle>We couldn't set your spending approval to zero</DialogTitle>
              <DialogDescription>Your automatic payment is still cancelled either way — this step is an extra precaution.</DialogDescription>
            </DialogHeader>
            <ErrorBanner error={state.error} onRetry={() => dispatch({ type: "CONFIRM_ZERO_ALLOWANCE" })} retryLabel="Try again" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => dispatch({ type: "SKIP_ALLOWANCE" })}>
                Skip for now
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {state.phase === "complete" ? (
          <>
            <DialogHeader>
              <CheckCircle2 className="text-foreground" />
              <DialogTitle>Automatic payment cancelled</DialogTitle>
              <DialogDescription>
                {state.allowanceWasAlreadyZero
                  ? "No future charges are possible. Your spending approval was already zero."
                  : "No future charges are possible."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)} data-testid="close-cancel-autopay-dialog-button">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
