# Contract Invariants

This document will enumerate every mandatory security invariant from CLAUDE.md §7
(authorization, amounts, time, replay resistance, state, tokens) and map each one to the
specific test that proves it holds, including the property-based adversarial suite run
against a malicious token contract.

Status: stub, filled in Phase 6 (invariant and property tests) and kept current through
Phase 14 (security hardening).

---

## Phase 1 — Types, Errors, Storage

The sections below are the factual record of what Phase 1 froze. The full invariant-to-test
mapping (CLAUDE.md §7 / PLAN.md §18) still lands in Phase 6; this is scoped to what Phase 1
itself introduced.

### Error code table (frozen ABI, `contracts/mandate-registry/src/error.rs`)

| Code | Name                     | Meaning                                                  |
|------|--------------------------|-----------------------------------------------------------|
| 1    | MandateNotFound          | No mandate exists for the given id.                        |
| 2    | MandateNotActive         | Mandate exists but is not in `Active` status.               |
| 3    | MandatePaused            | Mandate is `Paused`; charge attempted.                      |
| 4    | MandateRevoked           | Mandate is `Revoked`; charge attempted.                      |
| 5    | MandateCompleted         | Mandate is `Completed`; charge attempted.                    |
| 6    | MandateExpired           | Mandate is `Expired` (`now >= expires_at`); charge attempted. |
| 7    | ChargeBeforeStart        | `now < start_at`.                                            |
| 8    | ChargeTooSoon            | `min_interval_seconds` has not elapsed since `last_charged_at`. |
| 9    | InvalidAmount            | Charge amount is not positive.                               |
| 10   | AmountExceedsChargeLimit | Amount exceeds the fixed amount or `max_per_charge`.          |
| 11   | AmountExceedsPeriodLimit | Amount would push `current_period_collected` over `max_per_period`. |
| 12   | ChargeCountExceeded      | `successful_charges` already equals `max_successful_charges`. |
| 13   | DuplicateCharge          | `charge_id` already used for this mandate.                    |
| 14   | UnauthorizedMerchant     | Caller is not the mandate's authorized merchant.              |
| 15   | InsufficientAllowance    | Token allowance from payer to contract is too low.            |
| 16   | InsufficientBalance      | Payer's token balance is too low.                             |
| 17   | PaymentNotFound          | No payment receipt exists for the given payment id.           |
| 18   | RefundExceedsPayment     | Cumulative refund would exceed the original payment amount.   |
| 19   | DuplicateRefund          | `refund_id` already used.                                     |
| 20   | ArithmeticOverflow       | A checked arithmetic helper (`src/math.rs`) hit a bound.       |

These 20 discriminants are numbered exactly as CLAUDE.md §8 lists them and are a public ABI
contract: the backend maps the raw `u32` returned by a failed invocation back to this table.
Once assigned, a number is never renumbered or reused. New variants may only be appended above
20 (none were needed in Phase 1 itself).

### Storage durability decision

All Phase 1 storage keys — `Mandate(id)`, `Payment(payment_id)`, `UsedCharge(mandate_id,
charge_id)`, `UsedRefund(refund_id)`, `RefundedTotal(payment_id)` — use **persistent** storage,
never temporary. Rationale: Soroban temporary entries are deleted outright once their TTL
lapses, and a deleted key reads back indistinguishable from "never written". If a `charge_id` or
`refund_id` replay guard were temporary, an old id could be resubmitted successfully once its TTL
expired, silently breaking "a `charge_id` can succeed once at most" / "a `refund_id` can succeed
once at most" (CLAUDE.md §7 Replay resistance). The same reasoning extends to `Mandate` (losing
it would make a revoked/completed mandate look "not found" instead of correctly rejected) and to
receipts (revocation must never erase payment history). This is a security invariant, not a rent
cost optimization.

TTL policy (`contracts/mandate-registry/src/storage.rs`):

- `PERSISTENT_TTL_THRESHOLD = 17,280` ledgers (~1 day at the ~5s target ledger close time) — the
  point below which the next write re-extends an entry's TTL.
- `PERSISTENT_TTL_EXTEND_TO = 518,400` ledgers (~30 days) — how far out each bump pushes the
  entry's live-until-ledger.
- Every `set_*` / `mark_*` helper bumps TTL immediately after writing, so a mandate that goes
  quiet for weeks (paused, or between long billing periods) is not at risk of unexpected
  expiry-and-archival.
- No contract-level `instance()` config exists yet in Phase 1; the constants above are ready for
  Phase 2+ to reuse if/when one is introduced.

### Id derivation formulas (`contracts/mandate-registry/src/id.rs`)

```text
mandate_id = sha256(xdr_vec(network_id, contract_address, payer, merchant, asset, client_nonce))
payment_id = sha256(xdr_vec(mandate_id, charge_id))
```

`network_id` comes from `env.ledger().network_id()`, `contract_address` from
`env.current_contract_address()`. Binding both into the preimage means a mandate created on one
network, or against one deployment of this contract, can never collide with (or be replayed
against) a mandate on another network/deployment. The preimage is assembled as an explicit
`Vec<Val>` (not a Rust tuple) and hashed via `Bytes::to_xdr` + `env.crypto().sha256`; see the
`id.rs` module doc for why a tuple was not used directly.

`payment_id` derives 1:1 from `(mandate_id, charge_id)`: since `charge_id` is replay-guarded per
mandate (`UsedCharge`), a given pair can only ever produce one successful payment, so there is no
need for a separate on-chain sequence counter.

### Deviation from PLAN.md §10.3: `AmountRule::Variable`

PLAN.md sketches `AmountRule::Variable { max_per_charge: i128 }` as a named-field enum variant.
`soroban-sdk` 27's `#[contracttype]` macro rejects named (struct-style) enum variants outright —
confirmed via the exact compiler error `enum variant Variable has unsupported named fields`,
which traces to `soroban-sdk-macros-27.0.2/src/derive_enum.rs:65-70` (only unit and non-empty
tuple variants are supported). The contract now defines `Variable(i128)` — the same single
`max_per_charge` value carried positionally instead of by name. No business rule, invariant, or
serialized meaning changes; this is a mechanical, semantics-preserving adaptation to an SDK
constraint, not a product decision.
