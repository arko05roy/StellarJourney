/**
 * The checkout flow's state machine (CLAUDE.md §5 — discriminated unions for
 * state machines), kept as a plain reducer with no React/DOM/network
 * dependency so every transition is directly unit-testable.
 *
 * The one transition this exists specifically to get right: a
 * `create_mandate` success followed by an `approve` failure must NOT look
 * like a dead end. `mandateId` is set on `CREATE_MANDATE_SUCCESS` and never
 * cleared by a later `APPROVE_ERROR` — the UI reads `mandateId` off the
 * state to render "your automatic payment was created but isn't funded yet"
 * plus a retry-approve action, instead of a generic failure screen (the
 * task's explicit requirement: step 1 succeeding while step 2 fails must
 * never strand the payer).
 */
import type { DisplayError } from "./errors";

export type CheckoutPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "creating-mandate"
  | "approving"
  | "linking"
  | "complete"
  | "error";

export type CheckoutFailedStep = "connect" | "create-mandate" | "approve" | "link";

export interface CheckoutState {
  phase: CheckoutPhase;
  address?: string;
  mandateId?: string;
  failedStep?: CheckoutFailedStep;
  error?: DisplayError;
  /** Set only when `LINK_ERROR` happens *after* a successful approve — the mandate is fully created and funded on-chain, so this is a non-blocking warning shown alongside the confirmation screen, never a hard failure (CLAUDE.md §2: the on-chain result, not this DB association, is what matters). */
  linkWarning?: DisplayError;
}

export type CheckoutAction =
  | { type: "CONNECT_START" }
  | { type: "CONNECT_SUCCESS"; address: string }
  | { type: "CONNECT_ERROR"; error: DisplayError }
  | { type: "CREATE_MANDATE_START" }
  | { type: "CREATE_MANDATE_SUCCESS"; mandateId: string }
  | { type: "CREATE_MANDATE_ERROR"; error: DisplayError }
  | { type: "APPROVE_START" }
  | { type: "APPROVE_SUCCESS" }
  | { type: "APPROVE_ERROR"; error: DisplayError }
  | { type: "LINK_START" }
  | { type: "LINK_SUCCESS" }
  | { type: "LINK_ERROR"; error: DisplayError };

export const initialCheckoutState: CheckoutState = { phase: "idle" };

export function checkoutReducer(state: CheckoutState, action: CheckoutAction): CheckoutState {
  switch (action.type) {
    case "CONNECT_START":
      return { phase: "connecting" };
    case "CONNECT_SUCCESS":
      return { phase: "ready", address: action.address };
    case "CONNECT_ERROR":
      return { phase: "error", failedStep: "connect", error: action.error };

    case "CREATE_MANDATE_START":
      return { ...withoutError(state), phase: "creating-mandate" };
    case "CREATE_MANDATE_SUCCESS":
      return { ...withoutError(state), phase: "approving", mandateId: action.mandateId };
    case "CREATE_MANDATE_ERROR":
      return { ...state, phase: "error", failedStep: "create-mandate", error: action.error };

    case "APPROVE_START":
      return { ...withoutError(state), phase: "approving" };
    case "APPROVE_SUCCESS":
      return { ...withoutError(state), phase: "linking" };
    case "APPROVE_ERROR":
      // mandateId is deliberately preserved (see module doc) — this is the
      // "created but unfunded" state, not a dead end.
      return { ...state, phase: "error", failedStep: "approve", error: action.error };

    case "LINK_START":
      return { ...withoutError(state), phase: "linking" };
    case "LINK_SUCCESS":
      return { ...withoutError(state), phase: "complete" };
    case "LINK_ERROR":
      // Non-blocking: the mandate is already created and funded on-chain by
      // this point, so this surfaces as a warning on the confirmation
      // screen, not as an "error" phase with a retry-from-scratch flow.
      return { ...withoutError(state), phase: "complete", linkWarning: action.error };

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled checkout action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function withoutError(state: CheckoutState): CheckoutState {
  const { error: _error, failedStep: _failedStep, ...rest } = state;
  return rest;
}
