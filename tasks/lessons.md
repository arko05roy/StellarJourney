# Lessons

- soroban-sdk 27 `#[contracttype]` enums: named-field (struct-style) variants
  are rejected at compile time ("enum variant X has unsupported named
  fields"). Only unit variants and non-empty tuple variants work. Before
  sketching a new contract enum with `Variant { field: T }` shape, use
  `Variant(T)` instead. Verified against
  `soroban-sdk-macros-27.0.2/src/derive_enum.rs:65`.
- Hashing a heterogeneous tuple via `.to_xdr(env)` doesn't compile directly —
  tuples only get `IntoVal<Env, Vec<Val>>`, not `IntoVal<Env, Val>`, in this
  SDK version. Build an explicit `Vec<Val>` (push each field via
  `.into_val(env)`) and call `.to_xdr(env)` on that instead.
- Before checking soroban-sdk API behavior, read the vendored crate source at
  `~/.cargo/registry/src/index.crates.io-*/soroban-sdk-<version>` directly —
  faster and more reliable than guessing from memory or general web search.
- A `#![no_std]` contract crate needs `#[cfg(test)] extern crate std;` (once,
  in `lib.rs`) before any test module can use `std::vec![...]`,
  `std::vec::Vec`, etc. Without it, `std::` fails to resolve even though
  `soroban-sdk`'s `testutils` feature itself depends on std — the crate's own
  `no_std` attribute still blocks the path in *our* code.
- `MockAuth`/`MockAuthInvoke` (soroban-sdk 27 testutils) hold borrowed
  references (`invoke: &'a MockAuthInvoke`, `address: &'a Address`). Building
  them as inline temporaries inside `client.mock_auths(&[MockAuth { .. }])`
  fails to borrow-check ("temporary value dropped while borrowed") as soon as
  the resulting client is used in a *later* statement (e.g.
  `let mocked = client.mock_auths(&[..]); mocked.try_foo();`). Bind the
  `MockAuthInvoke` and the `[MockAuth; N]` array to their own `let`s first,
  then pass `&auths` — only works inline when `.mock_auths(...).method(...)`
  is one unbroken chain in a single statement.
- `Address::require_auth()` (no args) records, in `env.auths()`, an
  `AuthorizedInvocation` whose args equal the *actual arguments of the
  current contract invocation* — i.e. for `fn create_mandate(env, input)`
  calling `input.payer.require_auth()`, `env.auths()` shows args
  `(input,).into_val(&env)`, matching the top-level call args exactly. This
  only diverges when the contract explicitly calls
  `require_auth_for_args(custom_args)` instead.
- The generated `try_<method>` client function returns
  `Result<Result<T, ConversionError>, Result<Error, InvokeError>>` (two
  independent nested `Result`s, not one double-wrapped one) — unwrap with
  `.map_err(|e| e.expect("..."))` (peels the outer `Result<Error,
  InvokeError>` down to the contract's typed `Error`) then
  `.map(|inner| inner.expect("..."))` (peels the inner conversion result down
  to `T`), giving a clean `Result<T, Error>` for test assertions like
  `assert_eq!(result, Err(Error::Foo))`.
- `env.events().all()` returns a `ContractEvents` wrapper with no `.len()` —
  use `.events()` (returns `&[xdr::ContractEvent]`) and call `.is_empty()` /
  `.len()` on that slice instead. It also only reflects events from the
  *last* contract invocation (like `env.auths()`), so "no event on a
  rejected call" can be asserted directly after that one call without
  needing to filter by call boundary.
- To assert an exact `#[contractevent]` payload in a test without hand-
  building the topic/data XDR, construct the same event struct instance the
  contract would have published and call its own `.topics(&env)` /
  `.data(&env)` (via `soroban_sdk::Event` — `use soroban_sdk::Event as _;`),
  then compare `env.events().all()` against
  `soroban_sdk::vec![&env, (contract_id, expected.topics(&env), expected.data(&env))]`.
  `ContractEvents` has a `PartialEq<soroban_sdk::Vec<(Address, Vec<Val>, Val)>>`
  impl specifically for this.
- `soroban_sdk::token::TokenClient` requires a contract that implements the
  *exact* SEP-41 fn signatures (`allowance(from, spender) -> i128`,
  `approve(from, spender, amount, live_until_ledger)`, `balance(id) -> i128`,
  `transfer_from(spender, from, to, amount)`). A local test-only mock token
  used both via its own generated `MockTokenClient` (test setup: mint,
  approve) and via the generic `TokenClient` (from the contract under test)
  must match these signatures on the methods the contract actually calls
  through `TokenClient` — verified against
  `soroban-sdk-27.0.2/src/token.rs`'s `TokenInterface` trait doc rather than
  guessed. Note `transfer` (not `transfer_from`) takes `to: MuxedAddress` in
  this SDK version, not `Address` — irrelevant if the contract under test
  only ever calls `transfer_from`, but don't assume `transfer`'s signature
  without checking if you ever add a caller for it.
- When a contract-owned address (e.g. `env.current_contract_address()`) is
  passed as the `spender` to another contract's `transfer_from`, that inner
  contract's `spender.require_auth()` call succeeds automatically with *no*
  `mock_auths` entry needed for it — Soroban auto-authorizes a contract
  address when that contract is the direct invoker of the current call.
  This is what makes the bounded-allowance "contract is the spender" model
  work without the payer re-signing every charge; don't add a spurious
  mock-auth entry for the contract's own address in tests, it isn't needed
  and there's no address to sign it as anyway.
- A generated `<Contract>Client<'a>` struct's `env`/`address` fields are
  *owned* (`Env`, `Address`, both `.clone()`d in), not references — only the
  `mock_auths`/`set_auths` slice arguments are the `'a`-lifetime-bound part.
  Don't try to return a client with a hardcoded `'static` lifetime from a
  test helper (`fn setup() -> (.., MockTokenClient<'static>)`) if the caller
  will later chain `.mock_auths(&auths)` with a locally-scoped `auths`
  array — that forces the whole client type to `'static` at construction
  and then rejects the short-lived local borrow. Instead mirror the
  established `fn client(f: &Fixture) -> XClient<'_>` pattern (construct a
  fresh client from `&Fixture` fields on every call) so each call site's
  lifetime is inferred independently.
- `i128::checked_sub` does NOT fail on "insufficient balance" (e.g.
  `5i128.checked_sub(10)` = `Some(-5)`, a perfectly valid non-overflowing
  i128) — it only fails on true arithmetic overflow near `i128::MIN`. A
  mock/test token's "insufficient balance" or "insufficient allowance"
  panic must be an explicit `if updated < 0 { panic!(..) }` check *after*
  `checked_sub`, not something `checked_sub` itself detects.
- To assert storage state after an expected contract panic without ending
  the test (`#[should_panic]` terminates the test at the panic), wrap the
  call in `std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { .. }))`
  and optionally swap in a no-op `std::panic::set_hook` beforehand (restore
  the previous hook after) to silence the expected panic's stderr noise.
  Confirmed this doesn't interfere with `mock_auths`-based calls or
  Soroban's own trap propagation — a sub-invocation panic (e.g. a
  test-token's forced-failure branch) unwinds through the client's
  `try_*`/plain call exactly like an auth failure does.
- `env.events().all()` (and `env.auths()`) only reflect the *last* contract
  invocation. A test helper that wraps a call and then makes even one more
  contract call afterward for convenience (e.g. an invariant spot-check like
  `token.balance(&contract_id)` tacked onto the end of a `charge_success`
  helper) silently erases the prior call's events/auths for anyone who calls
  the helper and then tries to inspect them — the assertion doesn't error,
  it just compares against an empty list. Symptom: `assert_eq!(recorded,
  expected)` fails with `left: []` even though the code being tested
  genuinely published the events. Fix: keep any "make one more call to
  assert an invariant" helper strictly separate from the call whose
  events/auths matter, and call it only *after* the events/auths inspection
  is done, never folded into the same helper.
- Implementing a real `Completed` transition (previously only reachable via
  direct storage writes in earlier-phase tests) can retroactively invalidate
  an earlier phase's test that predicted a *different* rejection reason for
  what is now an unreachable intermediate state. Concretely: a step-N
  "count/threshold exceeded" pre-flight check that used to be the first
  thing a repeat caller would hit becomes permanently shadowed by an
  earlier status check the instant the threshold-reaching action itself
  starts performing the state transition atomically. When adding a
  transition like this, grep existing tests for the old error code the
  soon-to-be-shadowed check returns and update their expectations — and add
  a fresh bypass-based (direct storage write) test proving the shadowed
  check still independently fires, so it doesn't go silently untested.
