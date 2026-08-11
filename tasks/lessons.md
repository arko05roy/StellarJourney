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
