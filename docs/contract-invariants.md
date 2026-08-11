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

---

## Phase 2 — Mandate Lifecycle (create / pause / resume / revoke)

Scope: `create_mandate`, `pause_mandate`, `resume_mandate`, `revoke_mandate`, `get_mandate`
(`contracts/mandate-registry/src/lifecycle.rs`). No money movement — `charge` (Phase 3) is the
first point a token transfer occurs.

### New error codes (21–23)

Appended after the frozen 1–20 block (`contracts/mandate-registry/src/error.rs`); same ABI
stability rule applies — these are now frozen too, going forward only 24+ may be added.

| Code | Name                   | Meaning                                                                 |
|------|------------------------|--------------------------------------------------------------------------|
| 21   | InvalidMandateInput    | A `create_mandate` input bound failed (see table below) other than a non-positive amount-rule value, which uses `InvalidAmount` (9) since it already existed. |
| 22   | DuplicateMandate       | The derived `mandate_id` already has a stored mandate.                    |
| 23   | InvalidStateTransition | A lifecycle transition has no legal source/target pair and no more specific status error applies. Currently only `resume_mandate` called on an already-`Active` mandate. |

### `create_mandate` input validation (all checked before any storage write)

| Bound                                                              | Error on violation         |
|---------------------------------------------------------------------|-----------------------------|
| `Fixed(a)`: `a > 0`                                                  | `InvalidAmount`             |
| `Variable(max)`: `max > 0`                                           | `InvalidAmount`              |
| `max_per_period > 0`                                                 | `InvalidMandateInput`        |
| `max_per_period >= per_charge_cap` (the fixed amount or `max_per_charge`) | `InvalidMandateInput`    |
| `period_seconds > 0`                                                  | `InvalidMandateInput`        |
| `expires_at > start_at`                                               | `InvalidMandateInput`        |
| `expires_at > now` (refuse to create an already-dead mandate)          | `InvalidMandateInput`        |
| `payer != merchant` (no self-mandates)                                | `InvalidMandateInput`        |
| duplicate derived `mandate_id`                                        | `DuplicateMandate`           |

Two bounds are **intentionally unchecked**, both documented in `lifecycle::validate_input`:

- `min_interval_seconds` — `0` means "no interval constraint" and is legal; a value larger than
  `period_seconds` is also legal (a long interval inside a long period is a normal product
  shape, e.g. one charge per year inside a multi-year mandate). No upper or relative bound is
  enforced.
- `max_successful_charges` — **`0` means unlimited charges**, not zero charges. Any other `u32`
  value is a hard cap enforced once `charge` lands in Phase 3. This is the one place a "falsy"
  stored value inverts the intuitive reading, so it is called out explicitly here, in
  `types.rs`/`lifecycle.rs` doc comments, and must be mirrored by the backend/frontend layers
  that render this field (CLAUDE.md §20 — no duplicated, drifted business rules).

### Legal state-transition table

`Active`, `Paused`, `Revoked`, `Completed` are the four states that are ever actually
*persisted*. `Expired` is never persisted (see next section) — it only ever appears as a
lazily-computed value on read/write-time checks, so the table below lists it as a possible
*computed* source state for `pause`/`resume`/`revoke`, never as a source or destination the
contract writes to storage.

| Method           | Legal source → destination         | Rejected source → error                                                                 |
|------------------|--------------------------------------|--------------------------------------------------------------------------------------------|
| `pause_mandate`  | `Active → Paused`                    | `Paused → MandateNotActive`; `Revoked → MandateRevoked`; `Completed → MandateCompleted`; `Expired (computed) → MandateExpired` |
| `resume_mandate` | `Paused → Active`                    | `Active → InvalidStateTransition`; `Revoked → MandateRevoked`; `Completed → MandateCompleted`; `Expired (computed) → MandateExpired` |
| `revoke_mandate` | `Active → Revoked`, `Paused → Revoked`, `Expired (computed) → Revoked` | `Revoked → MandateRevoked`; `Completed → MandateCompleted` |

Two deliberate design choices embedded in this table:

1. **No silent idempotent no-ops.** Pausing an already-`Paused` mandate, resuming an
   already-`Active` mandate, or revoking an already-`Revoked` mandate all *reject* rather than
   succeeding a second time. A caller that thinks it's performing a real transition but hits a
   no-op would have that bug hidden from it; rejecting surfaces the mismatch immediately.
2. **Revoke is the only method with an `Expired (computed) → ...` success path.** See below.

### Computed-only expiry

`MandateStatus::Expired` is **never written to storage**, in any phase-2 code path. Instead:

- `get_mandate` derives it on every read: if the stored status is `Active` or `Paused` and
  `now >= expires_at`, the returned copy reports `Expired`; the stored record itself is
  untouched. A `Revoked` or `Completed` stored mandate keeps that terminal status even past
  `expires_at` — those are already final and must never be masked by `Expired`.
- `pause_mandate` / `resume_mandate` apply the same computed status internally before checking
  the transition table, and reject with `MandateExpired` if the computed status is `Expired`
  — but since rejection means no storage write happens at all, "not persisting `Expired`" and
  "rejecting an expired mandate" amount to the same code path here.
- `revoke_mandate` also computes status the same way, but — uniquely — treats a computed
  `Expired` mandate as a legal source for a successful transition straight to `Revoked` (see
  next section). It still never writes `Expired` itself; it writes `Revoked` directly.

Rationale for computed-only (recorded here per the Phase 2 lead decision, not re-litigated):
avoids a storage write on the read path (`get_mandate` stays side-effect-free, which also means
it can never fail with `ArithmeticOverflow` or interact with TTL bumps just from being read),
and avoids a second "which write actually flipped this to Expired" question for indexers — there
is no `mandate_expired` event for the same reason (see `events.rs` module doc).

### Revoke always permitted, even when expired

`revoke_mandate` succeeds against a mandate whose computed status is `Expired`, transitioning it
directly to `Revoked`. This is deliberate, not an oversight: CLAUDE.md §7 and PLAN.md §10.9 both
state revocation is the payer's **unconditional** right — it must never require merchant
approval and must be immediately effective. If expiry could block revocation, a payer who wants
their mandate visibly closed (e.g. for their own records, or so a merchant integration that
still reads stale off-chain state can see the terminal state on-chain) would have no way to
reach `Revoked` once `expires_at` passes — they'd be stuck with the mandate perpetually reporting
computed-`Expired` with no way to force the terminal, on-chain-persisted state they're entitled
to set. Allowing `Expired → Revoked` costs nothing security-wise (an expired mandate could not be
charged either way) and closes that gap.

### Authorization

`create_mandate` requires `input.payer.require_auth()`; `pause_mandate` / `resume_mandate` /
`revoke_mandate` require `mandate.payer.require_auth()` after loading the stored mandate. The
merchant and the relayer have zero lifecycle authority — proved in
`contracts/mandate-registry/src/test_lifecycle.rs` via `env.mock_auths` (never
`mock_all_auths`) with the *wrong* address mocked, so each `#[should_panic]` wrong-signer test
fails specifically because the payer's `require_auth()` finds no matching authorization entry,
not because auth was skipped entirely.

### Events

`mandate_created`, `mandate_paused`, `mandate_resumed`, `mandate_revoked` (`events.rs`), each
carrying `mandate_id`/`payer`/`merchant` as topics and a `timestamp`; `mandate_created` also
carries the full mandate terms (asset, amount rule, caps, window, `metadata_hash`) so an indexer
can reconstruct mandate state from events alone. No plaintext metadata is ever emitted — only
`metadata_hash`. There is no `mandate_expired` event in Phase 2 (see computed-only expiry above):
nothing is written to storage when expiry is merely observed, so there is no successful state
transition to attach such an event to. A rejected call (any `Err` return) never reaches the
`publish` call — proved by `pause_mandate_rejected_call_emits_no_event`.

---

## Phase 3 — Fixed Charge Execution

Scope: `charge`, `get_payment` (`contracts/mandate-registry/src/charge.rs`). The first point a
token transfer occurs. `AmountRule::Fixed` is fully enforced; `AmountRule::Variable`'s per-charge
cap is enforced generically (same code path, step 8 below) per the Phase 3 lead decision, but
`max_per_period` and billing-period rollover are Phase 4 — steps 11/12 below are wired at the
correct ordinal position as documented no-ops so Phase 4 can fill them in without reordering
anything.

No new error codes were needed — all of Phase 1's frozen 1–20 cover Phase 3's failure modes.

### Validation order as implemented (CLAUDE.md §6 — the order is itself a spec)

| Step | Check | Error on violation |
|------|-------|---------------------|
| 1 | Mandate exists | `MandateNotFound` |
| 2 | Status is `Active`, via `lifecycle::effective_status` (Phase 2's computed-expiry helper, now `pub(crate)` and reused here) | `MandatePaused` / `MandateRevoked` / `MandateCompleted` / `MandateExpired` |
| 3 | `now >= start_at` | `ChargeBeforeStart` |
| 4 | `now < expires_at` (defense-in-depth restatement — step 2 already rejects an expired `Active`/`Paused` mandate before this is reached in almost every case; kept as its own check at CLAUDE.md §6's exact ordinal position, not new logic) | `MandateExpired` |
| 5 | `mandate.merchant.require_auth()` | host trap if unauthorized (never a typed error — see Authorization proof method, Phase 2) |
| 6 | `charge_id` unused for this mandate | `DuplicateCharge` |
| 7 | `amount > 0` | `InvalidAmount` |
| 8 | Amount rule: `Fixed(a)` requires `amount == a` exactly (a *smaller* amount is also a violation, not only larger — CLAUDE.md §7); `Variable(max)` requires `amount <= max` | `AmountExceedsChargeLimit` |
| 9 | `min_interval_seconds` elapsed since `last_charged_at` (skipped on the first charge, when `last_charged_at` is `None`) | `ChargeTooSoon` |
| 10 | `max_successful_charges` not exceeded (`0` = unlimited, Phase 2 convention) | `ChargeCountExceeded` |
| 11 | Billing-period rollover — **Phase 4 no-op**: `current_period_start` is left exactly as `create_mandate` set it | — |
| 12 | Remaining period allowance — **Phase 4 no-op**: not checked against `max_per_period`; `current_period_collected` is still accumulated below so Phase 4 inherits a correct running total | — |
| 13 | Token allowance sufficient (`TokenClient::allowance(payer, contract)`) — advisory pre-flight only | `InsufficientAllowance` |
| 14 | Payer token balance sufficient (`TokenClient::balance(payer)`) — advisory pre-flight only | `InsufficientBalance` |
| — | `TokenClient::transfer_from(spender = contract, from = payer, to = merchant, amount)` | traps the whole invocation on failure (see Rollback below) |
| — | Accounting update, receipt store, `charge_succeeded` event | — |

Steps 13/14 are explicitly advisory: `transfer_from` remains the actual authority. They exist so
a relayer gets a typed, classifiable error instead of an opaque token-contract trap (CLAUDE.md
§11), which matters for retry classification (permanent policy failure vs. potentially
recoverable balance/allowance failure).

### Spender / allowance model

The mandate contract itself is the SEP-41 `spender` (PLAN.md §10.10): the payer approves *this
contract's address* for a bounded allowance, and `charge` calls
`token::TokenClient::transfer_from(&contract_address, &mandate.payer, &mandate.merchant,
&amount)`. When the mandate contract calls another contract's `transfer_from` with
`spender = env.current_contract_address()`, that inner `spender.require_auth()` call succeeds
automatically under Soroban's same-invocation contract-authorization rule — the mandate contract
is the direct invoker of that call, so no separate signature is required for it. This is exactly
what lets a payer approve once and have every subsequent charge execute without re-signing, while
still keeping the allowance itself bounded and payer-controlled.

### Contract never holds funds

`charge`'s only transfer call moves funds directly `payer -> merchant`; the contract's own
address is never `from` or `to` in any transfer it makes, so it never holds payment funds even
transiently (CLAUDE.md §7 Tokens). `charge_fixed_success_full_accounting_and_balances`
(`test_charge.rs`) asserts `token.balance(&contract_id) == 0` after a successful charge.

The merchant destination is read from the stored `Mandate` only — `charge`'s function signature
has **no merchant or destination argument at all**. This is what makes relayer redirection
structurally impossible rather than merely policy-forbidden: there is no parameter through which
an alternate destination could even be supplied.
`charge_cannot_redirect_funds_away_from_stored_merchant` proves an unrelated third-party address's
balance stays at `0` after a legitimately merchant-authorized charge, while the stored merchant's
balance increases by exactly `amount`.

### Accounting-mutates-only-after-transfer, and the rollback guarantee

`successful_charges`, `total_collected`, `current_period_collected`, `last_charged_at`, the
`UsedCharge` replay guard, the `PaymentReceipt`, and the `charge_succeeded` event are all written
strictly *after* `TokenClient::transfer_from` returns successfully — see the ordering in the
table above. If `transfer_from` traps (a real Soroban host trap, not a returned error), the entire
`charge` invocation traps with it, and the Soroban host discards every storage write the
invocation attempted, leaving the mandate and its replay guards exactly as they were before the
call.

This was **verified with a real failing token, not assumed**:
`charge_transfer_failure_rolls_back_and_allows_retry_with_same_charge_id` (`test_charge.rs`) uses
`mock-token`'s test-only `set_fail_transfers(true)` to force a genuine `transfer_from` trap, then
asserts, after catching the panic with `std::panic::catch_unwind`:

- `successful_charges`, `total_collected`, `current_period_collected` are all still `0`.
- `last_charged_at` is still `None`.
- `get_payment(payment_id)` returns `PaymentNotFound` — no receipt was stored.
- The `charge_id` is **not** marked used (`storage::has_used_charge` returns `false`) — proving a
  legitimate retry is still possible, not permanently burned by the failed attempt.

The test then flips `set_fail_transfers(false)` and retries the **same** `charge_id`, which
succeeds — proving the guard genuinely wasn't consumed by the failed attempt.

### `mock-token` (`contracts/mock-token`)

A minimal SEP-41/SAC-shaped contract (`mint`, `balance`, `approve`, `allowance`, `transfer`,
`transfer_from`) used only by `mandate-registry`'s dev-dependencies to drive real
contract-to-contract calls in tests, rather than stubbing the token interface. Two properties
make it explicitly test-only and documented as never-to-deploy:

1. `mint` has no admin authorization check — any caller can credit any address. Fine for seeding
   test fixtures, a critical vulnerability in a real token.
2. `set_fail_transfers(bool)` is a failure-injection switch with no real-token equivalent; it
   exists solely to produce the genuine `transfer_from` trap the rollback test above depends on.

`transfer_from`'s allowance/balance decrements use `checked_sub` plus an explicit `< 0` check
(not bare `checked_sub` alone) since `i128` subtraction below zero is a valid non-overflowing
value — the insufficiency itself is a business-rule panic, not an arithmetic overflow.
