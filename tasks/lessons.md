# Lessons

## Production homepage

- Mistake: deployment verification checked HTTP availability but did not inspect the visible root
  route, leaving a Phase 0 placeholder live.
- Rule: every frontend deployment must include a visual smoke test of `/` at desktop and mobile;
  reject placeholder or phase-scaffold copy before calling the deployment ready.

## Deployment handoff

- Mistake: gave a broad plan when the user asked what inputs were needed.
- Rule: list only exact external blockers: provider login/access, deployable Git ref, and required
  runtime secret; explicitly say when domain/email are optional.
- Mistake: assumed the frontend and backend should share one hosting provider.
- Rule: treat frontend and backend provider choices independently before creating deployment
  resources.

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
  `no_std` attribute still blocks the path in _our_ code.
- `MockAuth`/`MockAuthInvoke` (soroban-sdk 27 testutils) hold borrowed
  references (`invoke: &'a MockAuthInvoke`, `address: &'a Address`). Building
  them as inline temporaries inside `client.mock_auths(&[MockAuth { .. }])`
  fails to borrow-check ("temporary value dropped while borrowed") as soon as
  the resulting client is used in a _later_ statement (e.g.
  `let mocked = client.mock_auths(&[..]); mocked.try_foo();`). Bind the
  `MockAuthInvoke` and the `[MockAuth; N]` array to their own `let`s first,
  then pass `&auths` — only works inline when `.mock_auths(...).method(...)`
  is one unbroken chain in a single statement.
- `Address::require_auth()` (no args) records, in `env.auths()`, an
  `AuthorizedInvocation` whose args equal the _actual arguments of the
  current contract invocation_ — i.e. for `fn create_mandate(env, input)`
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
  _last_ contract invocation (like `env.auths()`), so "no event on a
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
  _exact_ SEP-41 fn signatures (`allowance(from, spender) -> i128`,
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
  contract's `spender.require_auth()` call succeeds automatically with _no_
  `mock_auths` entry needed for it — Soroban auto-authorizes a contract
  address when that contract is the direct invoker of the current call.
  This is what makes the bounded-allowance "contract is the spender" model
  work without the payer re-signing every charge; don't add a spurious
  mock-auth entry for the contract's own address in tests, it isn't needed
  and there's no address to sign it as anyway.
- A generated `<Contract>Client<'a>` struct's `env`/`address` fields are
  _owned_ (`Env`, `Address`, both `.clone()`d in), not references — only the
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
  panic must be an explicit `if updated < 0 { panic!(..) }` check _after_
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
- `env.events().all()` (and `env.auths()`) only reflect the _last_ contract
  invocation. A test helper that wraps a call and then makes even one more
  contract call afterward for convenience (e.g. an invariant spot-check like
  `token.balance(&contract_id)` tacked onto the end of a `charge_success`
  helper) silently erases the prior call's events/auths for anyone who calls
  the helper and then tries to inspect them — the assertion doesn't error,
  it just compares against an empty list. Symptom: `assert_eq!(recorded,
expected)` fails with `left: []` even though the code being tested
  genuinely published the events. Fix: keep any "make one more call to
  assert an invariant" helper strictly separate from the call whose
  events/auths matter, and call it only _after_ the events/auths inspection
  is done, never folded into the same helper.
- Implementing a real `Completed` transition (previously only reachable via
  direct storage writes in earlier-phase tests) can retroactively invalidate
  an earlier phase's test that predicted a _different_ rejection reason for
  what is now an unreachable intermediate state. Concretely: a step-N
  "count/threshold exceeded" pre-flight check that used to be the first
  thing a repeat caller would hit becomes permanently shadowed by an
  earlier status check the instant the threshold-reaching action itself
  starts performing the state transition atomically. When adding a
  transition like this, grep existing tests for the old error code the
  soon-to-be-shadowed check returns and update their expectations — and add
  a fresh bypass-based (direct storage write) test proving the shadowed
  check still independently fires, so it doesn't go silently untested.
- `soroban_sdk::token::TokenClient::transfer`'s real signature is
  `fn transfer(env, from: Address, to: MuxedAddress, amount: i128)` — this
  was flagged as a risk in an earlier lesson before any caller existed, and
  it mattered the moment `refund` added one. `MuxedAddress::from(&Address)`
  (or `.into()`) wraps a non-multiplexed address as the _same underlying
  `AddressObject` value_ an `Address`-typed parameter expects, so it decodes
  correctly even against a test-double contract method that still declares
  `to: Address` (didn't need to change `mock-token`'s simplified signature).
  Clippy's `needless_borrows_for_generic_args` will flag
  `&MuxedAddress::from(&x)` passed where `&MuxedAddress` might look required
  — the client wrapper accepts the owned value directly; drop the extra `&`.
- A single `Address::require_auth()` call only authorizes _one point_ in the
  call graph (the current contract invocation's own function + args). If
  your function calls `require_auth()` once and then invokes another
  contract whose method _also_ calls `require_auth()` on the same address
  (e.g. `refund`'s explicit `mandate.merchant.require_auth()` followed by
  `TokenClient::transfer`'s internal `from.require_auth()` where
  `from == merchant`), that is TWO separate auth requirements needing one
  signed tree, not one requirement satisfied twice. In tests, build a
  `MockAuthInvoke` with the nested call as a `sub_invokes` entry under the
  root — a flat `sub_invokes: &[]` on the root call will fail the nested
  call's own `require_auth()` with no matching entry. This is easy to miss
  because `charge`'s `transfer_from(spender = contract_address, ...)` never
  needed this (the contract auto-authorizes as its own spender), so the
  precedent in this codebase before Phase 5 had no two-level auth example to
  copy from.
- Before assuming a test-only mock contract's failure-injection flag (e.g.
  `mock-token`'s `set_fail_transfers`) covers every method you're about to
  add a new caller for, check which methods actually read the flag. Adding a
  second real caller of a previously-untested method (Phase 5's `refund`
  calling plain `transfer`, where only `transfer_from` had ever been called
  through `TokenClient` before) can silently produce a rollback test that
  never actually triggers a trap — it "passes" only because the transfer
  quietly succeeds instead of failing, and `expect_panic`'s assertion that a
  panic occurred is what catches this, not a silent false-positive. Wire the
  flag into the new method first, and add a direct unit test for it in the
  mock contract's own test module.
- `std::panic::catch_unwind(f)` where `f`'s captured state includes `Env`
  (or anything holding it, e.g. a test `Fixture` struct) fails to compile
  with a wall of "`RefCell`/`UnsafeCell` may contain interior mutability and
  a reference may not be safely transferable across a catch_unwind
  boundary" errors — `Env` wraps `Rc<RefCell<Host>>`-shaped internals and is
  never `RefUnwindSafe`/`UnwindSafe`. Always wrap the closure in
  `std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))` (not a bound
  of `F: UnwindSafe` on the helper's generic signature — that just moves the
  same compile error to every call site). Confirmed safe in practice for
  this use (asserting a panic occurred, then inspecting storage read-only
  afterward) since a caught host-level panic here never leaves `Env`'s
  storage in a torn state the test goes on to read incorrectly.
- Soroban's guest-to-guest cross-contract call path (`Env::invoke_contract`
  _and_ `Env::try_invoke_contract` both) always uses
  `ContractReentryMode::Prohibited` — verified directly in
  `soroban-env-host-27.0.1`'s `host.rs` (`default_external_call()` hard-codes
  `Prohibited`) and `host/frame.rs:924-956` (`Prohibited` rejects a call back
  into _any_ contract already anywhere in the invocation stack, not just
  literal self-recursion). This means a token contract cannot reenter the
  contract that's currently calling it via the standard call mechanism, full
  stop — no reentrancy guard needs to be hand-written in application
  contract code for this attack shape in this SDK/protocol version. The
  rejection surfaces as a genuine panic when the caller used the plain
  (non-`try_`) `invoke_contract` binding (its generated wrapper calls
  `.unwrap_infallible()` on the host result), so it propagates and aborts
  the _entire_ outer invocation, not just the reentrant sub-call.
- `soroban-sdk`'s `Env::default()` (under `testutils`/`cfg(test)`) writes a
  `test_snapshots/<test-name>.<N>.json` file for _every_ `Env` on drop by
  default (`EnvTestConfig::capture_snapshot_at_drop`, default `true`) —
  fine, and this repo's existing convention, for a test module with one
  `Env` per test function. A property/fuzz-style harness that constructs
  hundreds of short-lived `Env`s inside a single `#[test]` fn (one per
  random sequence) will otherwise dump hundreds of near-duplicate JSON
  files per run (observed: 250 files, 5.5MB, for a 250-sequence suite).
  Disable it selectively where this pattern applies via `let mut env =
Env::default(); env.set_config(EnvTestConfig { capture_snapshot_at_drop:
false });` (`soroban_sdk::testutils::EnvTestConfig`) — leave the default
  on everywhere else so the directed, deterministic test modules keep their
  committed snapshots.
- `clippy::unusual_byte_groupings` (part of `-D warnings`) fires on a hex
  literal with underscores unless every group has the same digit count —
  `0xC0FFEE_1234_5678` fails (group of 6, then two groups of 4); a leading
  `00` pad to make it `0x00C0_FFEE_1234_5678` (groups of 4) satisfies it. A
  literal with _no_ underscores at all (e.g. a raw 16-hex-digit constant
  like a golden-ratio PRNG multiplier) is exempt regardless of digit count —
  the lint only triggers once grouping is attempted and is inconsistent.
- `stellar contract build --package <name> --optimize` optimizes the wasm
  **in place**, overwriting `target/wasm32v1-none/release/<name>.wasm`
  itself — it does _not_ produce a separate `<name>.optimized.wasm` file.
  That distinct-file convention belongs to the older, now-deprecated
  `stellar contract optimize --wasm <path>` two-step command. A deploy
  script written against the two-step convention's output filename will
  fail with "No such file or directory" the first time it's actually run
  against the one-step `build --optimize` command — verified by running
  both and comparing `ls` output (39,711 bytes via the two-step command vs.
  26,857 bytes via `build --optimize` for the same source, so the two
  commands don't even produce byte-identical output — don't assume either
  one's filename or size convention without a real run).
- `@stellar/stellar-sdk/contract`'s `AssembledTransaction.signAuthEntries({ authorizeEntry })`
  is not a "supply your own signer" hook the way it first looks — the SDK
  _always_ calls whatever `authorizeEntry` function you pass with the exact
  same 5-argument signature as `@stellar/stellar-sdk`'s own `authorizeEntry`
  (`entry, signer, validUntilLedgerSeq, networkPassphrase, forAddress?`),
  where `signer` (2nd arg) is an SDK-internally-constructed wallet-style
  callback wrapping whatever `signAuthEntry` you provided (or a no-op if you
  didn't). To drive this with a bare `Keypair` instead of a wallet callback,
  write an `authorizeEntry` override that _ignores_ the 2nd argument
  entirely and calls the base `authorizeEntry(entry, keypair,
validUntilLedgerSeq, networkPassphrase, forAddress)` directly — confirmed
  by reading `signAuthEntries`'s actual implementation
  (`assembled_transaction.js`, not just the `.d.ts`): passing a
  reference-distinct custom `authorizeEntry` also skips the "you must
  provide `signAuthEntry`" validation entirely (that check is gated behind
  `authorizeEntry === <the default import>`), so `signAuthEntry` doesn't
  need to be supplied at all in this path. Verified working end-to-end on
  real testnet (Phase 7's merchant-authorizes/relayer-submits `charge`).
- Zod (v3) infers _any_ object field whose output type includes `undefined`
  as an optional TS property (`field?: T`) — this happens identically for
  both `.optional()` and `z.union([Schema, z.undefined()])`. This can never
  structurally match a hand-written domain type that models "key always
  present, value may be `undefined`" as `field: T | undefined` (a required
  key) under `exactOptionalPropertyTypes: true` — TS treats "optional key"
  and "required key typed `T | undefined`" as genuinely different shapes
  under that flag, so a `z.infer<...> extends DomainType` compile-time
  assertion will fail specifically on that one field even though the schema
  accepts every real value correctly at runtime. Don't fight this with more
  Zod cleverness — drop the compile-time assertion for that one field
  specifically (with a comment explaining why) and rely on runtime tests
  covering both the `undefined` and set cases instead.
- A committed `stellar contract bindings typescript` output file will not
  typecheck under a strict-by-default shared `tsconfig.base.json` as-is: it
  needs `lib: [..., "DOM"]` (for its own `typeof window !== "undefined"`
  Buffer-polyfill guard) and `noImplicitOverride: false` (the generated
  `Client` class overrides `ContractClient` members without the `override`
  keyword, since the codegen tool doesn't emit one). Scope both relaxations
  to just the package hosting the generated file's `tsconfig.json`, not the
  shared base config — confirmed the rest of the strict flags
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.) still
  apply fine to that package's hand-written files alongside the relaxed
  generated one.
- In a pnpm workspace, a Prisma schema that lives outside every package
  (e.g. a monorepo-root `prisma/schema.prisma`, per CLAUDE.md §4) breaks
  `prisma generate`'s default no-`output` behavior: it resolves
  `@prisma/client` relative to the _schema's own directory_, and if that
  directory has no satisfying install it shells out to
  `pnpm add @prisma/client@<version>` as a subprocess — which reliably
  failed (exit 1, no useful stderr) every time it was spawned from inside
  another `pnpm run` invocation (lockfile/store contention with the parent
  process), while the identical command run directly in a shell always
  succeeded. Fix: give `generator client` an explicit `output` path (e.g.
  `output = "./generated/client"`) — this is also Prisma's own documented
  forward-compatible pattern and sidesteps the whole resolution problem.
  Centralize the resulting deep relative import (`../../../prisma/generated/
client/index.js` or similar) in exactly one file per consuming package
  (mirror `packages/contract-client/src/deployment-registry.ts`'s existing
  repo-root-reach-through convention) so nothing else needs to know the path.
- Prisma's CLI (`prisma migrate deploy`/`generate`) reads `DATABASE_URL` from
  its own environment at invoke time — independent of whatever a
  `vitest.setup.ts` sets on `process.env` for the _test_ process. Running
  `prisma migrate deploy --schema ../../prisma/schema.prisma` from a
  different package's directory (e.g. `apps/api`, schema two levels up)
  won't pick up a root-level `.env` automatically. Fix: place a `.env`
  (gitignored, same as any other) directly next to `schema.prisma` — Prisma
  loads `.env` from the schema's own directory. In CI, set `DATABASE_URL` as
  a job/step-level environment variable instead; no file needed there.
- A plain `INSERT` (Prisma's typed `.create()`) that hits a unique-
  constraint violation _inside a transaction_ doesn't just fail that one
  statement — it poisons the entire enclosing Postgres transaction
  (`25P02: current transaction is aborted, commands ignored until end of
transaction block`). Catching the JS exception and then trying to run
  _any_ further query in that same transaction (e.g. a `SELECT` to read the
  winning row for an idempotency replay) fails too, even though the code
  "handles" the first error. For an insert-or-read-existing pattern that
  must stay in one transaction (to inherit Postgres's MVCC blocking
  behavior against a concurrent conflicting insert), use raw SQL
  `INSERT ... ON CONFLICT (...) DO NOTHING RETURNING id` instead — it keeps
  the same blocking-until-the-other-transaction-resolves semantics but
  never raises a Postgres-level error on a real conflict, only returns zero
  rows, so the transaction stays healthy for whatever reads come next.
  Caught by an actual 8-way-concurrent integration test against a real
  Postgres, not by inspection — the bug only manifested under genuine
  concurrent execution, never in the single-caller path.
- `@fastify/rate-limit` (v10, verified against its own source,
  `index.js:333`) does `throw params.errorResponseBuilder(req, respCtx)`
  **verbatim** — whatever plain object/value a custom `errorResponseBuilder`
  returns becomes the "error" Fastify's central `setErrorHandler` receives,
  completely unwrapped. Only the plugin's own _default_ builder returns a
  real `Error` instance with `.statusCode` set; a custom builder returning
  e.g. `{code, message}` with no `statusCode` field is indistinguishable
  from any other unexpected object once it reaches a generic error handler
  that checks `error.statusCode === 429` or `error instanceof Error` — it
  silently falls through to a 500 instead of the intended 429. If you
  override `errorResponseBuilder`, include `statusCode: context.statusCode`
  in the returned object (mirroring what the default builder does) and
  detect it in your error handler by that shape, not by `instanceof`.
- When two workspace apps share one real Postgres database for their own
  test suites (not mocked — this repo's own standard), `turbo run test`'s
  default task graph (`dependsOn: ["^build"]`) gives NO ordering between
  sibling apps' `test` tasks — they run concurrently. If both apps'
  `beforeEach` calls a full `cleanDatabase()` (delete every row), one
  suite's cleanup will delete rows the other suite's in-flight test still
  needs, producing real FK-violation failures that look like a totally
  unrelated bug in whichever test happened to lose the race — this was
  observed directly (`apps/api`'s and `apps/relayer`'s test suites both
  failing with `deleteMany()`/`create()` FK violations) the first time both
  suites coexisted in one `pnpm test` run, not predicted in advance. Fix:
  give the newer app's tests a distinct Postgres _schema_ (a namespace
  within the same database, via `DATABASE_URL`'s `?schema=` query param) —
  full physical isolation, no cross-process coordination needed, and
  `prisma migrate deploy` auto-creates the schema if it doesn't exist yet.
  Set the override where the `prisma migrate deploy` shell step itself runs
  (a package.json `test` script, via `export DATABASE_URL=... &&`), not only
  in `vitest.setup.ts` — `vitest.setup.ts` only takes effect once vitest's
  Node process starts, which is _after_ `migrate deploy` already ran as a
  separate `&&`-chained command against whatever `DATABASE_URL` was already
  in the shell environment.
- `@stellar/stellar-sdk/contract`'s `AssembledTransaction.signAndSend()` /
  `SentTransaction.send()` already polls `getTransaction` in a loop
  (exponential backoff, up to `DEFAULT_TIMEOUT` = 5 minutes) until a
  non-`NOT_FOUND` status, and `SentTransaction.result` parses the
  _confirmed_ `getTransactionResponse.returnValue` — not a replay of the
  earlier simulation. Verified by reading the SDK's own source
  (`lib/esm/contract/sent_transaction.js`), not assumed. A relayer/worker
  built on top of `submitAsInvoker`/`submitAsRelayer` does not need to
  hand-roll a "poll for final status" loop — that requirement is already
  satisfied by the point `signAndSend()`'s promise resolves. The final
  `getTransactionResponse` union type only carries a `ledger` field on its
  `SUCCESS`/`FAILED` variants, not `NOT_FOUND` — narrow with
  `"ledger" in finalResponse` (a real type guard) rather than a cast, since
  by the time `.result` is readable without throwing, the status is
  provably not `NOT_FOUND` but TypeScript doesn't know that automatically.
- A `const` binding that TypeScript has narrowed to non-null via an earlier
  `if (!x) throw` guard loses that narrowing the moment it's referenced
  inside a **nested function** defined later in the same scope (an arrow
  function assigned to a `const` and called later, e.g. a `fail(...)`
  closure) — TS conservatively widens back to the original nullable type
  there, since it can't prove the closure won't be invoked from somewhere
  else before the guard could matter. Fix: re-bind to a fresh `const` right
  after the guard (`const x = maybeX;` once `maybeX` is null-checked) rather
  than trying to get the closure to "see" the outer narrowing.
- A cross-app workspace dependency (e.g. `apps/relayer` depending on
  `@paymap/api` to reuse a shared table/helper, per an explicit "reuse it,
  don't duplicate it" instruction) works via a plain deep import to the
  dependency's **built** output (`@paymap/api/dist/state-machine.js`), the
  same way `apps/relayer`'s own `db.ts` reaches into
  `prisma/generated/client` — no `exports` field needed in the source
  package's `package.json` for this to resolve under
  `moduleResolution: "bundler"`, since deep subpath imports fall back to
  plain filesystem resolution when no `exports` map is declared. The only
  requirement is that the dependency actually gets built first, which
  `turbo.json`'s existing `dependsOn: ["^build"]` on the `build`/`typecheck`
  tasks already guarantees once the consuming package lists it as a real
  `dependencies` entry (pnpm workspace protocol) — no `turbo.json` change
  needed.
- `npx shadcn@latest init` (v4.16.0, `base-nova` preset) generates
  Tailwind-v4-only component syntax (`--spacing()` theme functions inside
  `[...]` arbitrary values, `@theme inline` CSS blocks) **regardless of
  which Tailwind major version it detects in the target project** —
  `components.json`'s recorded `tailwindVersion` was `"v3"` (the project's
  actual installed version at init time) and the CLI still emitted v4-only
  component source. First real symptom: `next build` fails with "Cannot
  apply unknown utility class `border-border`" (the plain CSS custom
  properties the CLI writes to `:root`/`.dark` are never registered as
  Tailwind color tokens under v3 — that registration is a v4 `@theme
inline` block the CLI simply doesn't emit for a v3-detected project).
  Fix was to actually migrate the project to Tailwind v4
  (`@tailwindcss/postcss`, `@import "tailwindcss"` replacing the three
  `@tailwind` directives, `@custom-variant dark (&:where(.dark, .dark *));`
  for class-based dark mode since v4 defaults to `prefers-color-scheme`)
  rather than trying to hand-patch v3-style token mappings to match
  components written in v4 syntax — after the v4 migration, **re-running**
  `shadcn init -y -d --force` regenerated a correct `@theme inline` mapping
  block automatically (it now detects v4 correctly and knows the token
  names each installed component actually needs), which was far more
  reliable than hand-authoring every `--radius-md`/`--color-*` variable
  name myself by reading each component's source. Lesson: after any
  `shadcn init`, immediately run `npx shadcn@latest info --json -c <app>`
  and check `project.tailwindVersion` actually matches what's installed
  before writing any component that depends on the generated theme tokens.
- A Next.js Client Component that imports **any** value binding from a
  workspace package's barrel `index.ts` pulls in that barrel's _entire_
  transitive module graph into the browser bundle — including a sibling
  module the import statement never actually touches, if that sibling is
  re-exported via `export * from "./other.js"` in the same barrel. Concrete
  case: `packages/contract-client/src/index.ts` re-exports both
  `./client.js` (pure) and `./deployment-registry.js` (`node:fs`/`node:path`/
  `node:url` at module-load time, for `loadDeployment`); a Client Component
  importing only `createMandateRegistryClient` from the bare package
  specifier still fails `next build` with `UnhandledSchemeError: Reading
from "node:fs" is not handled by plugins` (webpack has no browser
  polyfill for the Node builtin scheme). A **type-only** import from the
  same barrel (`import type { DeploymentRecord } from "@paymap/contract-client"`)
  is safe and adds nothing to the bundle (erased entirely at compile time,
  confirmed by reading the compiled output) — the failure mode is
  specifically a _value_ import through a barrel that also re-exports a
  Node-only module. Fix: add narrow subpath `exports` entries
  (`"./client"`, `"./domain"`) to the package's `package.json` pointing
  directly at the specific built files, and have the browser-bundled
  caller import value bindings from those subpaths instead of the root
  barrel — the root `"."` export stays untouched for every existing Node
  consumer (apps/api, apps/relayer, scripts).
- A Next.js App Router route with a `loading.tsx` boundary streams its
  response: the initial HTTP response (status 200, headers already sent)
  commits _before_ the async Server Component's work resolves. Calling
  `notFound()` (from `next/navigation`) deep inside that async work still
  renders the correct not-found UI content inside the stream, but **the
  already-committed HTTP status code stays 200** — verified directly via
  `curl` (`200` status, but the response body genuinely contains the
  not-found page's text). A Playwright assertion on `response.status()`
  for such a route will fail even though the user-visible behavior is
  entirely correct; assert on the rendered content instead
  (`getByRole("heading", ...)`), not the raw navigation response status,
  for any route with a `loading.tsx` sibling that can also call
  `notFound()`.
- `@creit.tech/stellar-wallets-kit` v2.5.0's public API is an all-static
  class (`StellarWalletsKit.init(...)`, `.authModal()`, `.signTransaction()`,
  `.signAuthEntry()`, `.disconnect()` — no `new StellarWalletsKit(...)`
  instance constructor) — verified against the installed package's actual
  `esm/sdk/kit.d.ts`, not assumed from older training-data examples of the
  library that used an instance API. Wallet modules (`FreighterModule`,
  `xBullModule`, etc.) are exported from per-wallet subpaths
  (`@creit.tech/stellar-wallets-kit/modules/freighter`), not from the
  package root — the root only re-exports `./sdk/mod.js` (the `kit`/
  `types` surface), `./components/mod.js`, and `./state/mod.js`.
  `StellarWalletsKit.signTransaction`/`.signAuthEntry`'s signatures match
  `@stellar/stellar-sdk/contract`'s `SignTransaction`/`SignAuthEntry` types
  exactly, so no adapter shim is needed to pass them straight into a
  generated contract client's `signTransaction`/`signAuthEntry` options.
- A SEP-41 token contract (a Stellar Asset Contract) has no published Wasm
  to derive a `ContractSpec` from (`stellar contract bindings typescript`
  has nothing to point at), so building an `approve`/`allowance` call from
  a browser/TS context can't reuse the generated-client pattern the way
  `mandate-registry` does. `@stellar/stellar-sdk/contract`'s
  `AssembledTransaction.build<T>({ method, args, contractId, ... })` is the
  right low-level primitive instead — build `args` as raw `ScVal`s via
  `nativeToScVal(value, { type: "address" | "i128" | "u32" })` from the
  base `@stellar/stellar-sdk` package (not `/contract`), matching SEP-41's
  known fixed signature by hand rather than needing a spec at all.
  `@stellar/stellar-sdk/contract` does **not** re-export `rpc` (that's
  `@stellar/stellar-sdk/rpc`'s `Server` export, aliased from
  `RpcServer` — confirmed by grepping `contract/index.d.ts`, which has no
  `rpc` line at all) — needed a separate import for `getLatestLedger()`
  when computing a bounded (never-unbounded) `live_until_ledger` for the
  approval.
- A merchant checkout page hosted on an arbitrary merchant-controlled
  domain, fetching an API on a different origin, needs that API to send
  CORS headers — obvious in hindsight, but easy to miss when every prior
  phase's API surface was server-to-server (relayer, scripts) or same-
  origin-irrelevant (bearer-token auth, `app.inject()` tests never go
  through a real browser fetch). Symptom when missing: the browser's
  `fetch()` fails with an opaque, generically-worded error (no CORS-
  specific message reaches JS) that a naive `/network|fetch|timeout/i`
  error-classifier will happily (and misleadingly) label "NETWORK_ERROR" —
  looks exactly like a real connectivity problem, not a CORS block, unless
  you specifically check the browser devtools/Playwright trace for a CORS
  console error. Caught by a real Playwright run against two different
  localhost ports (Next dev server + a mock API server), not by any unit
  test — `app.inject()`-based backend tests never exercise the browser's
  same-origin policy at all, so this class of bug is invisible to them by
  construction.
- `@testing-library/react`'s auto-cleanup between tests (unmounting whatever `render()` left in the
  DOM) only self-registers when a _global_ `afterEach` function exists (`typeof afterEach ===
'function'` check in its own source) - this requires `vitest.config.ts`'s `test.globals: true`.
  This repo's `apps/web/vitest.config.ts` doesn't set that (test files import
  `describe`/`it`/`afterEach` explicitly from `"vitest"` instead), so cleanup silently never ran:
  every `it()` in a multi-test file kept accumulating unmounted DOM from every prior test in that
  same file. Single-test-per-assertion-target files (or files whose later tests happen to query a
  testid the earlier test's final render state no longer contains) can go a long time without this
  ever causing a visible failure - it only surfaced once a new test file
  (`mandate-card.test.tsx`) had several tests all rendering something with the same testid
  (`pause-button`, `mandate-status-badge`, ...), which turned into `getByTestId`'s strict-mode
  "multiple elements found" error, not an obviously-cleanup-shaped symptom. Fix: add
  `afterEach(cleanup)` explicitly in `vitest.setup.ts` (`import { afterEach } from "vitest"; import
{ cleanup } from "@testing-library/react";`) - one central fix, not a per-test-file workaround,
  and it silently benefited every pre-existing component test file too once added.
- Also invalid-but-silently-transform-failing JSX: a prop written as
  `mandateId="a".repeat(64)` (missing the `{}` around a template/expression, i.e. string-literal
  syntax followed by a method call outside braces) is a parse error, not a type error - Vitest's
  esbuild-based transform reports it as a bare "Transform failed with 1 error" with no useful
  pointer to the exact prop, at the _file_ level, so every test in that file fails together. Always
  wrap any non-bare-string JSX attribute value in `{}` (`mandateId={"a".repeat(64)}`), and if a test
  file fails with an opaque transform error before any test even starts, grep it for `="` followed by
  a method call rather than assuming a logic bug.
- Playwright's `getByTestId`/`locator` matching is a plain CSS `[data-testid^="..."]` prefix/
  substring check, not testid-aware - a real testid like `mandate-card-fields` or
  `mandate-card-skeleton` will match a `[data-testid^="mandate-card-"]` locator too, and a
  `expect(locator).toBeVisible()` against a locator that resolves to 2+ elements throws a hard
  "strict mode violation" immediately (not retried away like a normal not-yet-visible assertion
  would be). When multiple sibling components in the same feature share a common testid prefix by
  coincidence (a list-item card, its own internal "fields" sub-region, and its loading-skeleton
  stand-in all starting with the same word), give the actual interactive/target element a longer,
  more specific prefix (`mandate-card-item-<id>`) rather than trying to retrofit exclusions into
  every consuming locator.
- A Next.js dashboard/list page whose cards filter by _live, derived_ status (e.g. "Upcoming"/
  "Active" tabs showing only `status === "Active"` mandates) will make a just-paused or just-
  revoked item disappear from the tab the user is looking at the instant the action confirms, since
  the live re-read immediately reflects the new status and the filter is re-evaluated on every
  render - there is no transitional "still shown here with an updated badge" moment unless the UI
  deliberately freezes the list's membership independent of live status. This is easy to miss when
  hand-writing an E2E flow that assumes "click pause, see the badge change in place" - the correct
  assertion is "the card leaves this tab, and reappears under the tab that now matches its new
  status," which is also arguably the more honest UX for a nav split that already has a dedicated
  "Paused & ended" tab.
- The WHATWG `URL` parser keeps the enclosing `[...]` on an IPv6 literal
  hostname (`new URL("https://[::1]/").hostname === "[::1]"`) — any
  `net.isIP`/DNS-shaped check downstream needs the bracket stripped first,
  or every IPv6-literal branch silently falls through to "not a recognized
  IP" / triggers an unwanted DNS lookup instead of matching. Also: `net.isIP`
  and `URL` both _normalize_ a dotted-quad IPv4-mapped IPv6 literal
  (`::ffff:127.0.0.1`) to its compressed-hex form (`::ffff:7f00:1`) — a
  regex written only against the dotted form silently misses the normalized
  one. Handle both forms explicitly (expand the `::`-compressed hextets by
  hand and decode the last 32 bits as two byte-pairs) rather than assuming
  either representation survives untouched.
- The "a Client Component value-importing anything from a workspace
  package's barrel drags in the barrel's entire re-export graph, including
  Node-only modules the import never touches" failure mode (first hit with
  `@paymap/contract-client`, see the earlier lesson above) recurs for _any_
  package whenever a new Node-only module is added to an already-consumed
  barrel — not just the original package. Adding three new `node:crypto`/
  `node:dns`/`node:net`-using modules to `@paymap/shared`'s barrel broke
  `apps/web`'s `next build` even though the browser code only ever imported
  `decimalToBaseUnits`/`baseUnitsToDecimalString` (pure, from `money.ts`).
  Same fix as before: add narrow subpath `exports` (`"./money"`, `"./types"`)
  and repoint the browser-bundled importers at the subpath. Treat this as a
  standing rule for this repo: before adding a Node-only module (crypto/dns/
  net/fs) to any package's barrel that `apps/web` also consumes, check
  `grep -rn "@paymap/<pkg>"` under `apps/web/src` first, and add a subpath
  export proactively rather than discovering the break at `pnpm build` time.
- Node's global `fetch`'s `RequestInit` type (from `@types/node`, no `DOM`
  lib) does not export a top-level `RequestInfo` type name the way `lib.dom`
  does — a test helper typed as `(input: RequestInfo | URL, init?: ...)`
  fails to compile ("cannot find name `RequestInfo`") in a `tsconfig` with
  `types: ["node"]` only. Use `Parameters<typeof fetch>[0]` /
  `Parameters<typeof fetch>[1]` instead of naming the DOM-lib type directly
  — resolves correctly regardless of which lib set is configured.
- Under `exactOptionalPropertyTypes: true`, `fetch(url, { body: maybeString
})` where `maybeString: string | undefined` fails to typecheck even though
  `RequestInit.body` is nominally `BodyInit | null | undefined` — the
  _inferred object literal's_ `body` property becomes `string | undefined`
  (assignable) vs. the target wanting the key entirely optional/absent when
  unset. Same fix as every other `exactOptionalPropertyTypes` hit in this
  repo: conditionally spread the key (`...(body !== undefined ? { body:
JSON.stringify(body) } : {})`) rather than passing `undefined` as a value.
- `undici`'s `Agent({ connect: { lookup } })` is the correct primitive for
  "pin this one HTTP request's actual TCP connection to a pre-validated IP
  while still using the real hostname for TLS SNI and the `Host` header" —
  needed for closing a DNS-rebinding TOCTOU gap between an SSRF
  allow-list check and the real connect a few milliseconds later. Import
  `fetch` from the `undici` package itself (not Node's ambient global
  `fetch`) when you need to pass a `dispatcher` option — the global
  `fetch`'s TS types (from `@types/node`) don't reliably include
  `dispatcher` in `RequestInit`, but `undici`'s own exported `fetch` does.
- A merchant-registered webhook secret needs both an encrypted-at-rest
  storage format _and_ a way for tests to prove round-trip correctness
  without ever asserting against the plaintext secret value inside a stored
  ciphertext string — `expect(encrypted).not.toContain(secret)` plus a
  separate `decryptWebhookSecret(encrypted, key) === secret` assertion is
  the right pair of checks; asserting only the second one would still pass
  even if encryption were accidentally a no-op wrapper.
- A Next.js Server Action that mutates a cookie (`cookies().set(...)`) and a
  Server Component page that redirects based on that same cookie's presence
  cannot coexist on the page the action was submitted from: Next.js
  re-renders the current route's Server Components as part of the _same_
  action response once a cookie changes, so a `redirect()` guarded on
  "cookie now present" fires before the client ever sees the action's own
  returned state — a "create account, then show the new secret exactly
  once on this same page" flow silently never shows the secret, jumping
  straight to the redirect target instead. No error, no warning — just a
  race the first real end-to-end (Playwright) run caught, not typecheck or
  unit tests (those never rendered the full page tree through a real
  Server Action round trip). Fix: the one page a "mutate a cookie and keep
  rendering here" action targets must not redirect on cookie presence at
  all; every _other_ page's normal "redirect if not connected" guard is
  unaffected and can stay as strict as before.
- `e2e/fixtures/mock-api-server.mjs`-style Node mock servers used by
  Playwright's `webServer` config are one shared process for the _entire_
  spec file when `fullyParallel: true` (the default in this repo's
  `playwright.config.ts`) — module-level mutable state shaped like a
  single object (`let merchant = {...}`) works fine for one test but
  produces real, intermittent cross-test 401s the moment a second test
  that also creates/rotates a "session" runs concurrently in another
  worker (observed directly: one test's API-key rotation invalidated
  another concurrently-running test's still-in-flight request). Keyed
  state (`Map<sessionKeyOrId, account>`) fixes it outright and costs
  nothing — model it that way from the first test onward in any mock
  server more than one spec file's test will ever exercise, rather than
  discovering the race only after adding a second test.
- `StrKey.isValidContract`/`isValidEd25519PublicKey` (from
  `@stellar/stellar-sdk`) genuinely checksum-validate — a hand-typed
  placeholder like `"C" + "A".repeat(55)` or `` `C${"A".repeat(55)}` ``
  (56 chars, right prefix) reliably fails validation despite looking
  plausible. Any test or fixture that needs a Zod schema built on these
  checks (e.g. `StellarContractAddressSchema`) to actually pass — not just
  a plain string field nothing validates — needs a real encoded value:
  `StrKey.encodeContract(Buffer.alloc(32, <any byte>))` (Node) or the
  browser-safe equivalent. Existing E2E fixture constants using the
  fake-looking form work fine _only_ where nothing actually runs
  `StrKey.isValid*` against them (e.g. a field just echoed back by a mock
  server, never client-side-validated) — don't copy that pattern into a
  form whose client-side validation (this repo's `validateProductForm`,
  for one) genuinely checksum-checks the address before allowing submit.
- The "a browser-bundled package's barrel re-exports a Node-only sibling"
  failure mode (`node:fs`/`node:path`/`node:url` leaking into a Next.js
  Client Component's bundle via a _value_ import through a barrel) recurs
  transitively, one layer removed from where the Node-only module actually
  lives. Adding `packages/stellar/src/events.ts` (which itself only imports
  from `@paymap/contract-client`'s _root_ barrel — not Node-only on its own)
  to `packages/stellar/src/index.ts`'s own barrel broke `apps/web`'s
  `next build` (`UnhandledSchemeError: Reading from "node:fs"`), because
  `contract-client`'s root barrel re-exports `deployment-registry.js`
  (`node:fs`) and `apps/web` already value-imports from `@paymap/stellar`'s
  root. The fix from the original lesson (add a narrow subpath export,
  `./events`, on the _inner_ package and import that instead of its root)
  applies exactly the same way one level up — but the bug has to be
  hunted down at `pnpm build` time (a real Next.js webpack error, not a
  typecheck or lint failure) since neither `tsc` nor `eslint` catch a
  transitive Node-only import reaching a browser bundle. Rule of thumb:
  before adding any new module to a package's root barrel, check whether
  that new module's own imports (even indirectly, through another
  workspace package's root) touch a Node builtin, and if so, add/consume a
  subpath export instead of touching the barrel.
