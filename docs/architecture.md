# Architecture

This document describes the end-to-end system architecture of Stellar Mandates: the
consumer/merchant web app, the merchant API, the untrusted relayer, the Soroban
mandate-registry contract, and the Stellar Asset Contract token interface they all depend on —
including the trust boundaries between each component (PLAN.md §9).

Status: Phase 0-6 built and tested the contract locally. Phase 7 (this section) deployed it to
Stellar testnet, proved it against a real Stellar Asset Contract (not just `mock-token`), and
built the TypeScript client layer everything above the contract will use. Refined further through
Phase 15 (demo polish).

---

## Phase 7 — Deployment and client layering

### Package layering (bottom to top)

```text
contracts/mandate-registry        Rust/Soroban — the policy authority
        │  (stellar contract bindings typescript)
        ▼
packages/contract-client          generated bindings + hand-written domain layer
        │  (i128 -> bigint, BytesN<32> -> hex, tag unions -> discriminated unions)
        ▼
packages/stellar                  tx submission (2 auth flows) + error decoding
        │
packages/shared                   Zod schemas + decimal<->base-unit money conversion
        │
scripts/, apps/api, apps/relayer, apps/web   (apps/* land in later phases)
```

`packages/contract-client` is the only package that imports the generated bindings
(`src/generated/mandate-registry.ts`, committed — see "Generated bindings" below). Everything else
imports the hand-written facade (`src/client.ts`, `src/domain.ts`) or `packages/stellar`'s
submission helpers, never the generated file directly.

### Deployment registry (`deployments/<network>.json`)

Written by `scripts/deploy-testnet.ts`, loaded by `packages/contract-client/src/deployment-registry.ts`.
Contains only public information — contract ids, wasm hash, RPC/network endpoints — so it is
committed, never gitignored. Keyed by network (`testnet`, and eventually `futurenet`/`mainnet`)
so multiple environments coexist without collision.

```json
{
  "network": "testnet",
  "networkPassphrase": "...",
  "contractId": "C...",
  "wasmHash": "...",
  "deployedAt": "2026-...",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "asset": { "code": "PUSD", "issuer": "G...", "contractId": "C...", "decimals": 7 }
}
```

The `asset` field records the SEP-41 test asset used to prove the contract against a **real**
Stellar Asset Contract, not just the local `mock-token` test double (see below).

### Test asset: a real classic asset + SAC, not an existing testnet USDC

`scripts/deploy-testnet.ts` issues a classic Stellar asset (`PUSD`, issued by a repo-controlled
`paymap-asset-issuer` identity) and deploys its Stellar Asset Contract
(`stellar contract asset deploy`). This was chosen over reusing an existing testnet USDC SAC
because the issuer key needs to be under our own control so the payer account can be freely
(re-)funded to any balance the demo needs, with no faucet dependency. A SAC's `approve` /
`allowance` / `transfer_from` / `transfer` / `balance` semantics are identical regardless of which
classic asset it wraps, so this does not weaken the proof at all.

**Result: real SAC semantics matched `mock-token` exactly.** `scripts/create-demo-mandate.ts`'s
`approve` -> `create_mandate` -> `charge` sequence against the real PUSD SAC succeeded with no
divergence from the Phase 3-6 `mock-token`-based test suite's assumptions about the SEP-41
interface. No stop condition was triggered.

### Generated bindings vs. hand-written facade

`packages/contract-client/src/generated/mandate-registry.ts` is produced by
`stellar contract bindings typescript` and committed (regenerate command is in the file's own
header comment). It is excluded from ESLint (`**/generated/**`, `packages/config/eslint.config.mjs`)
but still typechecked as part of `pnpm typecheck` — this required two narrow, documented
deviations in `packages/contract-client/tsconfig.json` (`lib: ["ES2022", "DOM"]` for the codegen
tool's own `typeof window` browser-compat guard, and `noImplicitOverride: false` since the
generated `Client` class overrides `ContractClient` members without the modifier); every other
package keeps the base config's full strictness.

`packages/contract-client/src/domain.ts`/`client.ts` wrap it: every `i128`/`u64` is a `bigint`
(never a JS `number`, CLAUDE.md §5), every `BytesN<32>` id is a lowercase hex string, and
`AmountRule`/`MandateStatus` are proper discriminated unions/string-literal types instead of the
generated `{tag, values}` shape.

### The two authorization flows (`packages/stellar/src/submit.ts`)

Both rely on the generated client's own "simulate before you sign" behavior — every method call
returns an already-simulated `AssembledTransaction`, and `assertSimulatedOk` refuses to proceed to
a signature at all if that simulation already came back `Err`.

1. **Payer-signs-and-submits** (`submitAsInvoker`) — `create_mandate`, `pause_mandate`,
   `resume_mandate`, `revoke_mandate`. The payer is both the invocation's required signer and the
   transaction's source account.
2. **Merchant-authorizes/relayer-submits** (`submitAsRelayer`) — `charge`, `refund`, the core trust
   boundary of the whole product. The relayer is the transaction's source account (pays the fee,
   owns the sequence number) but never signs the merchant's authorization entry; the merchant
   signs only that one Soroban auth entry via `AssembledTransaction.signAuthEntries({ address,
   authorizeEntry })`.

`packages/stellar/src/signer.ts`'s `keypairSigner(secretKey)` wraps a raw `Keypair` as both
callback shapes the SDK needs (`signTransaction` for the tx envelope, an `authorizeEntry` override
for one auth entry) without hand-rolling any hashing/signing logic itself — both delegate straight
to `@stellar/stellar-sdk`'s own `authorizeEntry`/`Transaction.sign`.

**Result: this flow worked exactly as designed on real testnet.** `scripts/create-demo-mandate.ts`
uses three genuinely distinct Stellar identities — payer, merchant, and a separate `paymap-relayer`
— and the relayer never holds the merchant's or payer's key at any point. See the Phase 7 `##
Review` entry in `tasks/todo.md` for the real transaction hashes this produced.

### Error decoding (`packages/stellar/src/errors.ts`)

A frozen table mapping the contract's `u32` error codes (`contracts/mandate-registry/src/error.rs`)
to `{ name, retryable }`, with `retryable` following CLAUDE.md §11's relayer retry policy exactly
(permanent: revoked/expired/duplicate/over-limit/too-soon/max-count; transient, per merchant
policy: insufficient allowance/balance). `packages/stellar/src/errors.test.ts` parses `error.rs`
directly and asserts the TS table never drifts from the Rust source — a mismatch here would
silently misclassify real failures in production.

### Money (`packages/shared/src/money.ts`)

`decimalToBaseUnits`/`baseUnitsToDecimalString` are the only place decimal-string (API-facing) and
integer-base-unit (on-chain, `bigint`) amounts convert between each other (CLAUDE.md §9). Every
classic-asset SAC uses exactly 7 decimals; the conversion functions themselves are asset-agnostic
and take `decimals` as a parameter. Over-precision input is rejected outright, never rounded.
