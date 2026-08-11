/**
 * Decodes `contracts/mandate-registry/src/events.rs`'s 5 mandate-lifecycle
 * `#[contractevent]`s out of a Soroban RPC `getEvents()` response entry
 * (Phase 12c — on-chain indexer, PLAN.md §11, CLAUDE.md §12).
 *
 * Wire shape, verified directly against `soroban-sdk-macros-27.0.2`'s
 * `derive_event.rs` (not assumed from memory):
 *   - `topics`: `[Symbol(snake_case(struct_name)), ...#[topic] fields in
 *     declaration order]`. Every event in `events.rs` declares its topics in
 *     the same order — `mandate_id`, `payer`, `merchant` — so topics are
 *     always `[name, mandate_id, payer, merchant]` here.
 *   - `data`: an `ScvMap` (the macro's default `data_format`, never
 *     overridden in `events.rs`) of every non-`#[topic]` field, keyed by its
 *     Rust field name. `@stellar/stellar-sdk`'s `scValToNative` turns an
 *     `ScvMap` into a plain object keyed by the (already-`Symbol`-decoded)
 *     field name, so this reads fields by name, never by position.
 *
 * `charge_succeeded`/`refund_succeeded` (the other two `events.rs` events)
 * decode to `undefined` here — this indexer's scope (Phase 12c) is only the
 * 5 mandate-lifecycle events; those two already have producers
 * (`apps/relayer/src/pipeline.ts`) and are out of scope.
 */
import { scValToNative, type rpc } from "@stellar/stellar-sdk";
import { idToHex } from "./domain.js";

export type MandateLifecycleEventKind =
  | "mandate_created"
  | "mandate_paused"
  | "mandate_resumed"
  | "mandate_revoked"
  | "mandate_completed";

const LIFECYCLE_EVENT_KINDS: ReadonlySet<string> = new Set<MandateLifecycleEventKind>([
  "mandate_created",
  "mandate_paused",
  "mandate_resumed",
  "mandate_revoked",
  "mandate_completed",
]);

function isLifecycleEventKind(name: string): name is MandateLifecycleEventKind {
  return LIFECYCLE_EVENT_KINDS.has(name);
}

/** Fields common to every decoded lifecycle event, including the on-chain coordinates the indexer needs for cursor/dedup bookkeeping. */
interface MandateLifecycleEventBase {
  mandateId: string;
  payer: string;
  merchant: string;
  timestamp: bigint;
  /** Ledger this event was emitted in. */
  ledger: number;
  txHash: string;
  /**
   * Soroban RPC's own event id (e.g. `"<ledger>-<index>"`) — deterministic
   * given the same on-chain data (derived purely from ledger/tx/operation/
   * event position, never anything random), so two indexer instances
   * observing the same real event always compute the same value. Used as
   * the deterministic `WebhookDelivery.eventId` (prefixed `chain:`) — the
   * backstop that makes re-processing an overlapping ledger range produce
   * at most one webhook per on-chain event.
   */
  rpcEventId: string;
}

export type MandateLifecycleEvent =
  | (MandateLifecycleEventBase & { kind: "mandate_created"; asset: string })
  | (MandateLifecycleEventBase & { kind: "mandate_paused" })
  | (MandateLifecycleEventBase & { kind: "mandate_resumed" })
  | (MandateLifecycleEventBase & { kind: "mandate_revoked" })
  | (MandateLifecycleEventBase & { kind: "mandate_completed"; successfulCharges: number });

/** Thrown when an event's topic/data shape doesn't match what `events.rs` is expected to publish — a real ABI drift, not a recoverable condition. */
export class MandateEventDecodeError extends Error {
  constructor(message: string, rpcEventId: string) {
    super(`${message} (rpcEventId=${rpcEventId})`);
    this.name = "MandateEventDecodeError";
  }
}

/**
 * Decodes one `rpc.Server.getEvents()` response entry. Returns `undefined`
 * for anything that isn't one of the 5 mandate-lifecycle events (including
 * `charge_succeeded`/`refund_succeeded`, or an event name this client
 * doesn't recognize) — never throws for those, since a contract may
 * legitimately emit other event types this decoder has no reason to reject.
 * Throws {@link MandateEventDecodeError} only when the topic/data *shape* of
 * a recognized lifecycle event name doesn't match what `events.rs` publishes
 * — that is a genuine ABI mismatch worth failing loudly on, not something to
 * silently skip.
 */
export function decodeMandateLifecycleEvent(raw: rpc.Api.EventResponse): MandateLifecycleEvent | undefined {
  const topics = raw.topic.map((t) => scValToNative(t) as unknown);
  const name = topics[0];
  if (typeof name !== "string" || !isLifecycleEventKind(name)) {
    return undefined;
  }

  const mandateIdRaw = topics[1];
  const payer = topics[2];
  const merchant = topics[3];
  if (!(mandateIdRaw instanceof Uint8Array)) {
    throw new MandateEventDecodeError(`"${name}" event's topic[1] ("mandate_id") is not bytes`, raw.id);
  }
  if (typeof payer !== "string") {
    throw new MandateEventDecodeError(`"${name}" event's topic[2] ("payer") is not an address`, raw.id);
  }
  if (typeof merchant !== "string") {
    throw new MandateEventDecodeError(`"${name}" event's topic[3] ("merchant") is not an address`, raw.id);
  }

  const data = scValToNative(raw.value) as Record<string, unknown>;
  const timestamp = data["timestamp"];
  if (typeof timestamp !== "bigint") {
    throw new MandateEventDecodeError(`"${name}" event's data.timestamp is not a u64`, raw.id);
  }

  const base: MandateLifecycleEventBase = {
    mandateId: idToHex(mandateIdRaw),
    payer,
    merchant,
    timestamp,
    ledger: raw.ledger,
    txHash: raw.txHash,
    rpcEventId: raw.id,
  };

  switch (name) {
    case "mandate_created": {
      const asset = data["asset"];
      if (typeof asset !== "string") {
        throw new MandateEventDecodeError(`"mandate_created" event's data.asset is not an address`, raw.id);
      }
      return { kind: "mandate_created", ...base, asset };
    }
    case "mandate_completed": {
      const successfulCharges = data["successful_charges"];
      if (typeof successfulCharges !== "number") {
        throw new MandateEventDecodeError(`"mandate_completed" event's data.successful_charges is not a u32`, raw.id);
      }
      return { kind: "mandate_completed", ...base, successfulCharges };
    }
    case "mandate_paused":
      return { kind: "mandate_paused", ...base };
    case "mandate_resumed":
      return { kind: "mandate_resumed", ...base };
    case "mandate_revoked":
      return { kind: "mandate_revoked", ...base };
  }
}
