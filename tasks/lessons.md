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
