/**
 * "Cancel autopay" (revoke) state machine (CLAUDE.md §5 — discriminated
 * unions for state machines), kept as a plain reducer with no React/DOM/
 * wallet dependency, mirroring `checkout-state.ts`'s existing pattern.
 *
 * Revocation itself is immediate and unconditional (PLAN.md §10.9) — the
 * instant `revoke_mandate` confirms, this mandate can never be charged
 * again, full stop. What this reducer sequences *after* that point is the
 * lead's decision #3: prompt the payer to also zero their token allowance,
 * explaining that a lingering allowance is a standing risk even though the
 * revoked mandate itself now blocks every future charge attempt. Declining
 * the prompt is always a legitimate, first-class outcome (`SKIP_ALLOWANCE`)
 * — the mandate is already safely cancelled regardless.
 */
import type { DisplayError } from "./errors";

export type RevokeFlowPhase =
  | "idle"
  | "confirming"
  | "revoking"
  | "revoke-error"
  | "allowance-prompt"
  | "checking-allowance"
  | "zeroing-allowance"
  | "zero-allowance-error"
  | "complete";

export interface RevokeFlowState {
  phase: RevokeFlowPhase;
  error?: DisplayError;
  /** Set once a `checking-allowance`/`zeroing-allowance` step has confirmed there was nothing to zero — lets the UI show "nothing more to do" instead of a redundant success message. */
  allowanceWasAlreadyZero?: boolean;
}

export type RevokeFlowAction =
  | { type: "OPEN_CONFIRM" }
  | { type: "CLOSE" }
  | { type: "CONFIRM_REVOKE" }
  | { type: "REVOKE_SUCCESS" }
  | { type: "REVOKE_ERROR"; error: DisplayError }
  | { type: "CHECK_ALLOWANCE_START" }
  | { type: "CHECK_ALLOWANCE_RESULT"; allowance: bigint }
  | { type: "CONFIRM_ZERO_ALLOWANCE" }
  | { type: "ZERO_ALLOWANCE_SUCCESS" }
  | { type: "ZERO_ALLOWANCE_ERROR"; error: DisplayError }
  | { type: "SKIP_ALLOWANCE" };

export const initialRevokeFlowState: RevokeFlowState = { phase: "idle" };

export function revokeFlowReducer(state: RevokeFlowState, action: RevokeFlowAction): RevokeFlowState {
  switch (action.type) {
    case "OPEN_CONFIRM":
      return { phase: "confirming" };
    case "CLOSE":
      // Legal from "confirming" (backed out before signing anything) and
      // from a completed/skipped flow (dismiss the summary). Never legal
      // mid-signature or mid-submission — those phases have no CLOSE arm
      // below, so the switch's default (thrown) catches a misuse there.
      if (state.phase === "confirming" || state.phase === "complete" || state.phase === "revoke-error" || state.phase === "zero-allowance-error") {
        return { phase: "idle" };
      }
      throw new Error(`cannot CLOSE from phase "${state.phase}"`);

    case "CONFIRM_REVOKE":
      return { phase: "revoking" };
    case "REVOKE_SUCCESS":
      return { phase: "checking-allowance" };
    case "REVOKE_ERROR":
      return { phase: "revoke-error", error: action.error };

    case "CHECK_ALLOWANCE_START":
      return { phase: "checking-allowance" };
    case "CHECK_ALLOWANCE_RESULT":
      // Nothing to zero — the flow is already effectively complete; skip
      // straight past the prompt rather than asking for a pointless
      // signature.
      return action.allowance > 0n ? { phase: "allowance-prompt" } : { phase: "complete", allowanceWasAlreadyZero: true };

    case "CONFIRM_ZERO_ALLOWANCE":
      return { phase: "zeroing-allowance" };
    case "ZERO_ALLOWANCE_SUCCESS":
      return { phase: "complete" };
    case "ZERO_ALLOWANCE_ERROR":
      return { phase: "zero-allowance-error", error: action.error };

    case "SKIP_ALLOWANCE":
      return { phase: "complete" };

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled revoke-flow action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
