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
- `soroban_sdk::token::TokenClient::transfer`'s real signature is
  `fn transfer(env, from: Address, to: MuxedAddress, amount: i128)` — this
  was flagged as a risk in an earlier lesson before any caller existed, and
  it mattered the moment `refund` added one. `MuxedAddress::from(&Address)`
  (or `.into()`) wraps a non-multiplexed address as the *same underlying
  `AddressObject` value* an `Address`-typed parameter expects, so it decodes
  correctly even against a test-double contract method that still declares
  `to: Address` (didn't need to change `mock-token`'s simplified signature).
  Clippy's `needless_borrows_for_generic_args` will flag
  `&MuxedAddress::from(&x)` passed where `&MuxedAddress` might look required
  — the client wrapper accepts the owned value directly; drop the extra `&`.
- A single `Address::require_auth()` call only authorizes *one point* in the
  call graph (the current contract invocation's own function + args). If
  your function calls `require_auth()` once and then invokes another
  contract whose method *also* calls `require_auth()` on the same address
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
  *and* `Env::try_invoke_contract` both) always uses
  `ContractReentryMode::Prohibited` — verified directly in
  `soroban-env-host-27.0.1`'s `host.rs` (`default_external_call()` hard-codes
  `Prohibited`) and `host/frame.rs:924-956` (`Prohibited` rejects a call back
  into *any* contract already anywhere in the invocation stack, not just
  literal self-recursion). This means a token contract cannot reenter the
  contract that's currently calling it via the standard call mechanism, full
  stop — no reentrancy guard needs to be hand-written in application
  contract code for this attack shape in this SDK/protocol version. The
  rejection surfaces as a genuine panic when the caller used the plain
  (non-`try_`) `invoke_contract` binding (its generated wrapper calls
  `.unwrap_infallible()` on the host result), so it propagates and aborts
  the *entire* outer invocation, not just the reentrant sub-call.
- `soroban-sdk`'s `Env::default()` (under `testutils`/`cfg(test)`) writes a
  `test_snapshots/<test-name>.<N>.json` file for *every* `Env` on drop by
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
  literal with *no* underscores at all (e.g. a raw 16-hex-digit constant
  like a golden-ratio PRNG multiplier) is exempt regardless of digit count —
  the lint only triggers once grouping is attempted and is inconsistent.
- `stellar contract build --package <name> --optimize` optimizes the wasm
  **in place**, overwriting `target/wasm32v1-none/release/<name>.wasm`
  itself — it does *not* produce a separate `<name>.optimized.wasm` file.
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
  *always* calls whatever `authorizeEntry` function you pass with the exact
  same 5-argument signature as `@stellar/stellar-sdk`'s own `authorizeEntry`
  (`entry, signer, validUntilLedgerSeq, networkPassphrase, forAddress?`),
  where `signer` (2nd arg) is an SDK-internally-constructed wallet-style
  callback wrapping whatever `signAuthEntry` you provided (or a no-op if you
  didn't). To drive this with a bare `Keypair` instead of a wallet callback,
  write an `authorizeEntry` override that *ignores* the 2nd argument
  entirely and calls the base `authorizeEntry(entry, keypair,
  validUntilLedgerSeq, networkPassphrase, forAddress)` directly — confirmed
  by reading `signAuthEntries`'s actual implementation
  (`assembled_transaction.js`, not just the `.d.ts`): passing a
  reference-distinct custom `authorizeEntry` also skips the "you must
  provide `signAuthEntry`" validation entirely (that check is gated behind
  `authorizeEntry === <the default import>`), so `signAuthEntry` doesn't
  need to be supplied at all in this path. Verified working end-to-end on
  real testnet (Phase 7's merchant-authorizes/relayer-submits `charge`).
- Zod (v3) infers *any* object field whose output type includes `undefined`
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
  `@prisma/client` relative to the *schema's own directory*, and if that
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
  `vitest.setup.ts` sets on `process.env` for the *test* process. Running
  `prisma migrate deploy --schema ../../prisma/schema.prisma` from a
  different package's directory (e.g. `apps/api`, schema two levels up)
  won't pick up a root-level `.env` automatically. Fix: place a `.env`
  (gitignored, same as any other) directly next to `schema.prisma` — Prisma
  loads `.env` from the schema's own directory. In CI, set `DATABASE_URL` as
  a job/step-level environment variable instead; no file needed there.
- A plain `INSERT` (Prisma's typed `.create()`) that hits a unique-
  constraint violation *inside a transaction* doesn't just fail that one
  statement — it poisons the entire enclosing Postgres transaction
  (`25P02: current transaction is aborted, commands ignored until end of
  transaction block`). Catching the JS exception and then trying to run
  *any* further query in that same transaction (e.g. a `SELECT` to read the
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
  completely unwrapped. Only the plugin's own *default* builder returns a
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
  give the newer app's tests a distinct Postgres *schema* (a namespace
  within the same database, via `DATABASE_URL`'s `?schema=` query param) —
  full physical isolation, no cross-process coordination needed, and
  `prisma migrate deploy` auto-creates the schema if it doesn't exist yet.
  Set the override where the `prisma migrate deploy` shell step itself runs
  (a package.json `test` script, via `export DATABASE_URL=... &&`), not only
  in `vitest.setup.ts` — `vitest.setup.ts` only takes effect once vitest's
  Node process starts, which is *after* `migrate deploy` already ran as a
  separate `&&`-chained command against whatever `DATABASE_URL` was already
  in the shell environment.
- `@stellar/stellar-sdk/contract`'s `AssembledTransaction.signAndSend()` /
  `SentTransaction.send()` already polls `getTransaction` in a loop
  (exponential backoff, up to `DEFAULT_TIMEOUT` = 5 minutes) until a
  non-`NOT_FOUND` status, and `SentTransaction.result` parses the
  *confirmed* `getTransactionResponse.returnValue` — not a replay of the
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
  workspace package's barrel `index.ts` pulls in that barrel's *entire*
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
  specifically a *value* import through a barrel that also re-exports a
  Node-only module. Fix: add narrow subpath `exports` entries
  (`"./client"`, `"./domain"`) to the package's `package.json` pointing
  directly at the specific built files, and have the browser-bundled
  caller import value bindings from those subpaths instead of the root
  barrel — the root `"."` export stays untouched for every existing Node
  consumer (apps/api, apps/relayer, scripts).
- A Next.js App Router route with a `loading.tsx` boundary streams its
  response: the initial HTTP response (status 200, headers already sent)
  commits *before* the async Server Component's work resolves. Calling
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
