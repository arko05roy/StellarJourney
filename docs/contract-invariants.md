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

---

## Phase 4 — Variable Charge + Billing-Period Accounting

Scope: `charge.rs` steps 11-12 (billing-period rollover, `max_per_period` enforcement) and the
post-transfer `Completed` transition. No new error codes were needed — `AmountExceedsPeriodLimit`
(11) was already frozen in Phase 1, unused until now.

### Period-index formula and boundary semantics

```text
period_index = floor((now - start_at) / period_seconds)
computed_period_start = start_at + period_index * period_seconds
```

`now >= start_at` is already guaranteed by validation step 3 (which runs before step 11), so the
subtraction cannot underflow, and `period_seconds > 0` is guaranteed for the mandate's entire
lifetime by `create_mandate`'s input validation (Phase 2) — it is never mutated afterward — so the
division can never panic.

**Boundary is `>=`, not `>`.** At `now == start_at + n*period_seconds` exactly, integer division
gives `period_index == n` — the charge is already classified as belonging to period `n`, not
`n - 1`. A charge one second before that boundary still resolves to `period_index == n - 1`. Both
directions are asserted explicitly:
`test_period::period_boundary_second_before_still_old_period_exact_boundary_is_new_period`
constructs a mandate whose single period-saturating charge means "still old period" is
observable as a period-cap rejection, and "new period" as a fresh-allowance success, at adjacent
timestamps one second apart.

### How "the stored period" is identified

The `Mandate` struct persists `current_period_start` (a timestamp), not an index. `charge.rs`
identifies whether this charge is still in the same period as last time by **comparing the
freshly computed `computed_period_start` directly against the stored `current_period_start`**,
rather than deriving a stored index from `current_period_start` and comparing indices. Both
approaches are mathematically equivalent given `period_seconds`'s immutability, but the direct
boundary comparison was chosen because it needs no extra assumption about how
`current_period_start` was produced — it is the one value the `Mandate` actually persists, so
comparing against it directly is the more literal statement of "is this still the period we last
recorded."

- If `computed_period_start != mandate.current_period_start`: this charge is the first one
  observed in a period that has never been seen before. The *effective* `current_period_collected`
  for this charge is `0` (a full reset) and the *effective* `current_period_start` is
  `computed_period_start`.
- If they match: the effective collected total is whatever is already stored — this charge is
  still within the same period as the last charge.

### Skipped periods resolve in one step, never a loop

Because `computed_period_start` is derived directly from a single division (`period_index =
floor((now - start_at) / period_seconds)`), a long gap between charges — e.g. five whole periods
with no charges at all — still resolves to the correct far-forward boundary in one arithmetic
step. There is no "advance one period at a time" loop that could under- or over-shoot, and the
allowance can only ever be reset once for whichever period `now` actually falls in.
`test_period::period_skipped_periods_land_in_correct_far_forward_boundary` proves this: after a
5-period gap, `current_period_start` lands exactly on period 5's boundary
(`start_at + 5*period_seconds`), not period 1's boundary and not `now` itself.

### Rollover sets the boundary, never `now`

`current_period_start` is always written as `computed_period_start` (`start_at +
period_index*period_seconds`), **never as `now`**. Setting it to `now` would let the billing
window drift forward on every charge instead of staying pinned to fixed-duration boundaries from
`start_at` — the entire reason PLAN.md §9/§10.7 mandate fixed-duration periods instead of
calendar-relative ones. `test_period::period_rollover_resets_allowance_and_sets_boundary_not_now`
charges at a timestamp strictly inside period 1 and asserts `current_period_start` equals the
period boundary (`start_at + period_seconds`), explicitly asserting it does **not** equal `now`.

### `max_per_period` enforcement (step 12)

`effective_period_collected + amount <= max_per_period`, else `AmountExceedsPeriodLimit`, using
`math::checked_add_i128`. Proven with: two charges in the same period summing to exactly the cap
(both succeed), a third charge of any positive amount immediately after (rejected), and — via a
mandate written directly into storage, since `create_mandate` can never itself produce a mandate
whose per-charge cap exceeds `max_per_period` — a single first-in-period charge whose amount alone
exceeds the cap (also rejected), proving step 12 is an independent defense layer and not merely
unreachable dead code riding on step 8's per-charge cap.

### Rollover-then-completion computation order, and the rollback guarantee

Per the Phase 4 lead decision, the effective `current_period_collected` / `current_period_start`
are **computed** at steps 11-12 (before any token call) but **written to storage only after
`transfer_from` returns successfully**, in the same accounting block as every other Phase 3
accounting field. There is no separate write path that persists rollover independently of a
successful charge — this preserves the Phase 3 rollback invariant (a failed transfer traps the
whole invocation, and the Soroban host discards every storage write made so far) without any new
code path that could break it.

This was verified with a real failing token, not assumed:
`test_period::rollover_reverts_on_failed_transfer_leaves_period_state_unchanged` charges once to
saturate period 0, advances into period 1 (a charge here would roll the period over), forces
`mock-token`'s `set_fail_transfers(true)`, and asserts — via a direct storage read after catching
the resulting panic — that the mandate is **byte-for-byte identical** to its state before the
failed attempt (`current_period_start`, `current_period_collected`, and every other field). It then
flips the token back to working and retries the same `charge_id`, which now genuinely rolls the
period over.

### Completion transition

After a successful charge, if `mandate.max_successful_charges != 0` (`0` still means unlimited,
the Phase 2 convention) and the just-incremented `successful_charges` equals it exactly, the
mandate's `status` is set to `Completed` and a `mandate_completed` event (`events.rs`) is
published — both inside the same post-transfer accounting block as the rest of the charge's
effects, so completion can never be observed without the charge that caused it also having
succeeded (and vice versa: the charge cannot succeed without completion also being applied, if the
count condition holds).

`test_period::completion_reaches_max_charges_transitions_and_rejects_next_charge` proves the whole
chain: the charge that reaches the cap emits both `charge_succeeded` and `mandate_completed` (in
that order, asserted against `env.events().all()` immediately after the call — before any other
contract invocation, since that view only reflects the *last* invocation), the stored `status`
becomes `Completed`, and the very next charge attempt fails with `MandateCompleted` — not
`ChargeCountExceeded`, since step 2 rejects on stored status before step 10 is ever reached.
`test_period::completion_unlimited_max_charges_zero_never_completes` proves the converse: a
mandate with `max_successful_charges == 0` charges past an arbitrary count while remaining
`Active`.

**Consequence for step 10 (`ChargeCountExceeded`):** because completion now happens atomically the
instant `successful_charges` reaches a non-zero cap, a subsequent charge against a mandate created
and charged only through the public API will always be rejected at step 2 (`MandateCompleted`)
before step 10 is ever reached — step 10 is effectively dead code through that path alone. It
remains real defense-in-depth against a mandate whose `successful_charges` already equals
`max_successful_charges` while `status` is still `Active`, a combination `create_mandate` can never
produce but which `test_period::charge_count_exceeded_still_enforced_via_bypassed_active_state`
constructs directly in storage to prove step 10 independently rejects it. This also required
updating a Phase 3 test
(`test_charge::charge_max_successful_charges_reached_rejected`): its second charge attempt now
correctly expects `MandateCompleted` instead of the Phase-3-era `ChargeCountExceeded`, since the
first charge already completed the mandate.

### `period_index` in `charge_succeeded` is now authoritative

Phase 3 computed the event's `period_index` directly from `start_at` as a placeholder (documented
there as informational-only, since `current_period_start` was never recomputed). Phase 4 emits the
same `period_index` value computed at steps 11-12 — the authoritative value now that real rollover
exists — with no other change to the event's shape.

### Interaction with `min_interval_seconds`

Validation step 9 (interval) runs before steps 11-12 (rollover), so a period rollover can never
bypass the interval check: if a mandate's `period_seconds` is shorter than its
`min_interval_seconds`, a charge attempted after the period has rolled over but before the interval
has elapsed still correctly fails with `ChargeTooSoon`, not a period-reset success.
`test_period::min_interval_still_enforced_across_a_period_rollover` proves both halves: the
too-early attempt (past the period boundary, short of the interval) rejects with `ChargeTooSoon`,
and the same amount at the interval boundary succeeds with the freshly rolled-over allowance.

---

## Phase 5 — Refunds

Scope: `refund`, `get_refund`, `get_refunded_total` (`contracts/mandate-registry/src/refund.rs`).
One new error code was needed — `RefundNotFound` (24) — for `get_refund`'s not-found case; no
existing code fits without being actively misleading (see below).

### New error code (24)

| Code | Name           | Meaning                                                                 |
|------|----------------|--------------------------------------------------------------------------|
| 24   | RefundNotFound | `get_refund` found no stored `RefundReceipt` for the given `refund_id`. Genuinely new: `DuplicateRefund` (19) means the *opposite* — a `refund_id` already consumed by a successful refund — so reusing it for "not found" would misreport one deterministic failure as another, which CLAUDE.md §8 forbids. Parity with `PaymentNotFound` (17) for `get_payment`. |

Error 16 (`InsufficientBalance`)'s doc comment was broadened, not renumbered: it now covers both
the payer's balance (`charge`) and, since this phase, the merchant's balance (`refund`) — same
advisory-pre-flight role in both callers, same code, no new variant needed.

### Validation order as implemented

| Step | Check | Error on violation |
|------|-------|---------------------|
| 1 | Mandate exists | `MandateNotFound` |
| 2 | Payment exists | `PaymentNotFound` |
| 3 | Payment belongs to `mandate_id` | `PaymentNotFound` (not a distinct "mismatched mandate" error — see rationale below) |
| 4 | `mandate.merchant.require_auth()` | host trap if unauthorized |
| 5 | `refund_id` unused (**global** scope — see below) | `DuplicateRefund` |
| 6 | `amount > 0` | `InvalidAmount` |
| 7 | `refunded_total[payment_id] + amount <= payment.amount` (checked add) | `RefundExceedsPayment` |
| 8 | Merchant token balance sufficient — advisory pre-flight only | `InsufficientBalance` |
| — | `TokenClient::transfer(from = merchant, to = payer, amount)` | traps the whole invocation on failure (see Rollback below) |
| — | `RefundedTotal` update, `UsedRefund` mark, `RefundReceipt` store, `refund_succeeded` event | — |

**No mandate-status check anywhere in this order** — this is the central Phase 5 decision, not an
oversight. See "Refunds are permitted in every mandate state" below.

Step 3 deliberately reuses `PaymentNotFound` rather than introducing a new "wrong mandate" error:
from the caller's point of view, passing a `payment_id` that exists but isn't this mandate's is
observationally identical to passing one that doesn't exist under this mandate at all — the
caller supplied a `(mandate_id, payment_id)` pair with no valid payment, full stop.

### The `transfer` (not `transfer_from`) model — merchant authorizes directly

Refund moves money **merchant -> payer**, the reverse direction of a charge. `refund.rs` calls
`TokenClient::transfer(&payment.merchant, MuxedAddress::from(&payment.payer), &amount)` —
`transfer`, not `transfer_from`. There is no allowance on either side: `transfer`'s real SEP-41
signature is `fn transfer(env, from: Address, to: MuxedAddress, amount: i128)`
(`soroban-sdk-27.0.2/src/token.rs`), and it authorizes via `from.require_auth()` inside the token
contract — i.e. the merchant, as `from`, must authorize this token-level call directly, exactly
like a person paying someone back out of their own wallet. `MuxedAddress::from(&Address)` wraps a
plain (non-multiplexed) address as the same underlying `AddressObject` value the token contract's
`to: Address` parameter expects, so passing a never-multiplexed payer address through this
conversion decodes identically to passing an `Address` directly — verified in this contract's own
test suite (`test_refund.rs` exercises it against `mock-token`'s literal `to: Address` parameter),
not merely assumed from the SDK's documented forward-compatibility guarantee ("this type is
compatible with `Address` at the contract interface level").

**Two separate `require_auth()` calls, one signed tree.** The merchant authorizes *two* distinct
points in the call graph for one `refund` invocation: the top-level `refund` call itself
(`mandate.merchant.require_auth()`, step 4 above) and the nested token `transfer` call
(`from.require_auth()` inside the token contract). Both resolve from a single signed authorization
tree — the root entry for `(mandate_registry, "refund", args)` carries the nested `transfer` call
as a `sub_invocation`, exactly mirroring what a real merchant wallet would present as one signature
request. `test_refund.rs`'s `refund_as` helper builds this exact two-level `MockAuthInvoke` tree.

The payer, merchant, and asset used for both the transfer call and the stored `RefundReceipt` are
read **from the `PaymentReceipt`**, never from the mandate record or from call arguments — the
receipt is the immutable record of what actually moved on the original charge, so a refund can
only ever undo exactly that, structurally, not just by policy.

### No-headroom-restoration rule (the point of this phase)

A refund does **not** decrement `mandate.total_collected`, `mandate.current_period_collected`, or
`mandate.successful_charges`, and does not un-complete a `Completed` mandate. `refund.rs` never
writes the `Mandate` record at all — it only reads `mandate.merchant` for the authorization check.

**Rationale (anti-bypass):** if a refund restored spending headroom, a merchant could
charge -> refund -> charge in a loop and collect (and keep) unbounded real economic value while
every individual balance check still reports compliance with `max_per_period` /
`max_successful_charges`. Those caps are meant to bound *gross* collection over a mandate's
lifetime — every dollar the mandate contract was ever authorized to move — not *net-of-refunds*
collection. A refund is a separate, merchant-initiated act (goodwill, dispute resolution, a
billing correction) that sits on top of the original charge's already-consumed headroom; it does
not entitle the merchant to collect that headroom a second time.

Proven by two tests, both required and both landed:
`test_refund::refund_does_not_restore_period_headroom` (charge to the period cap, fully refund it,
then prove a same-period same-fixed-amount charge still fails with `AmountExceedsPeriodLimit`) and
`test_refund::refund_does_not_uncomplete_mandate_or_decrement_successful_charges` (complete a
mandate via `max_successful_charges`, refund its only payment, assert `status` is still
`Completed` and `successful_charges`/`total_collected` are unchanged).

### Global `refund_id` uniqueness scope

`storage::has_used_refund`/`mark_refund_used` operate on the bare `UsedRefund(refund_id)` key
inherited from Phase 1 — there is no `(payment_id, refund_id)` or `(mandate_id, refund_id)`
composite key. A `refund_id` is therefore unique across the **entire contract**, not scoped to one
payment or one mandate: the same `refund_id` can never succeed twice, even against two completely
different payments under two completely different mandates. This mirrors how an API
`Idempotency-Key` is treated — a single global namespace the caller (typically the merchant
backend) is responsible for generating collision-resistant values within — deliberately different
from `charge_id`, which is scoped per-mandate by an already-composite `(mandate_id, charge_id)`
key. `test_refund::refund_duplicate_refund_id_rejected_across_different_payments` proves the global
scope explicitly: the same `refund_id`, reused against a different payment under the same mandate,
is still rejected with `DuplicateRefund`.

### Refunds are permitted in every mandate state

`refund` performs **zero** mandate-status checks — no `Active`/`Paused`/`Revoked`/`Completed`/
computed-`Expired` branch anywhere in its validation order. This is deliberate: refusing to refund
a cancelled, expired, paused, or completed subscription would be user-hostile (a merchant should
always be able to make a customer whole) and is not itself a security property — unlike a charge,
a refund can only ever move money **out of** the merchant's own control and **into** the payer's,
strictly bounded by the original payment amount (step 7). There is no way for a refund to be used
to extract more value than the mandate ever authorized moving in the first place.

Proven by four required state-independence tests, one per non-`Active` status:
`refund_succeeds_on_revoked_mandate`, `refund_succeeds_on_paused_mandate`,
`refund_succeeds_on_expired_mandate` (advances past `expires_at` and confirms `get_mandate` reports
computed-`Expired` before refunding), and `refund_succeeds_on_completed_mandate`.

### Accounting-mutates-only-after-transfer, and the rollback guarantee

`RefundedTotal(payment_id)`, the `UsedRefund` replay guard, and the `RefundReceipt` are all written
strictly *after* `TokenClient::transfer` returns successfully — identical discipline to
`charge.rs`. If `transfer` traps, the entire `refund` invocation traps with it and the Soroban host
discards every storage write attempted so far.

This was **verified with a real failing token, not assumed** — and required a small fix to
`mock-token` first: `mock-token`'s `transfer` function did not originally consult the
`set_fail_transfers` flag at all (only `transfer_from` did, since Phase 3 never exercised plain
`transfer` through the generic `TokenClient`). `mock-token::transfer` was updated to honor the flag
identically to `transfer_from`, so the refund rollback test can force a genuine trap the same way
the charge rollback test does — this is a test-fixture fix, not a contract behavior change, and
`mock-token`'s own test module gained direct coverage of both the new `transfer` happy path and its
failure-injection path.

`test_refund::refund_transfer_failure_rolls_back_and_allows_retry_with_same_refund_id` forces
`mock-token`'s `set_fail_transfers(true)`, catches the resulting panic with
`std::panic::catch_unwind`, and asserts via direct storage reads that `RefundedTotal` is still `0`,
no `RefundReceipt` exists (`get_refund` returns `RefundNotFound`), and the `refund_id` is **not**
marked used. It then flips the token back to working and retries the identical `refund_id`, which
succeeds — proving the replay guard was never consumed by the failed attempt, exactly mirroring the
Phase 3 charge rollback proof.

### `RefundedTotal` is per-payment, mandate accounting is untouched by refunds elsewhere

`test_refund::refund_of_older_payment_does_not_disturb_newer_charge_accounting` charges twice under
one mandate, refunds only the older payment in full, and confirms the newer payment's own
`RefundedTotal` is still `0`, its receipt is unchanged, and `mandate.total_collected`/
`successful_charges` (which never decrement on any refund, per the no-headroom-restoration rule
above) still reflect both original charges.
