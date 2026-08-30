# Stellar Mandates

Recurring stablecoin payments with spending limits enforced by a Soroban smart contract. A payer authorizes a bounded mandate and token allowance; merchants can collect only within the signed amount, timing, frequency, and charge-count rules. Payers can pause, resume, or revoke immediately.

## Production links

- App: [paymap-web.vercel.app](https://paymap-web.vercel.app)
- API readiness: [paymap-demo-api.onrender.com/readyz](https://paymap-demo-api.onrender.com/readyz)
- Prometheus metrics: [paymap-demo-api.onrender.com/metrics](https://paymap-demo-api.onrender.com/metrics)
- Stellar testnet contract: [`CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22`](https://stellar.expert/explorer/testnet/contract/CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22)
- Testnet `charge` transaction: [86b09bb3…20528c](https://stellar.expert/explorer/testnet/tx/86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c)
- Repository: [github.com/arko05roy/StellarJourney](https://github.com/arko05roy/StellarJourney)

## Submission readiness

| Requirement | Status | Evidence |
| --- | --- | --- |
| Public repository | Ready | [StellarJourney on GitHub](https://github.com/arko05roy/StellarJourney) |
| Live application | Ready | [Open the app](https://paymap-web.vercel.app) |
| Live API and monitoring | Ready | [Readiness](https://paymap-demo-api.onrender.com/readyz) · [Metrics](https://paymap-demo-api.onrender.com/metrics) |
| Testnet contract | Ready | [Contract on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22) |
| Contract interaction | Ready | [Successful `charge` transaction](https://stellar.expert/explorer/testnet/tx/86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c) |
| CI/CD | Ready | [Green `main` workflow](https://github.com/arko05roy/Paymap/actions/runs/30534296778) |
| Testnet activity | Ready | [52 verified transactions](docs/level-5/evidence/testnet-stress-20260730045306-585217.csv) |
| Feedback workbook | Template only | [Feedback analysis workbook](docs/level-5/Paymap-User-Feedback-Analysis.xlsx) |
| Public feedback form | Pending | [Form specification](docs/level-5/google-form-spec.md) |
| Demo video | Pending | [Recording script](docs/demo-script.md) |

The complete technical and submission matrix is in [`docs/level-5/submission-evidence.md`](docs/level-5/submission-evidence.md).

## Product evidence

| Desktop app | Mobile app |
| --- | --- |
| ![Stellar Mandates desktop app](docs/level-5/evidence/product-ui-desktop.png) | ![Stellar Mandates mobile app](docs/level-5/evidence/product-ui-mobile.png) |

![Wallet-first merchant onboarding](docs/level-5/evidence/merchant-wallet-onboarding.png)

| Green CI/CD | Frontend tests |
| --- | --- |
| ![Green GitHub Actions workflow](docs/level-5/evidence/ci-main-green.png) | ![Frontend test output](docs/level-5/evidence/test-output.png) |

| Live monitoring | Testnet transaction |
| --- | --- |
| ![Live Prometheus metrics](docs/level-5/evidence/monitoring-metrics.png) | ![Successful testnet charge](docs/level-5/evidence/testnet-charge-transaction.png) |

More capture details are recorded in [`docs/level-5/evidence/README.md`](docs/level-5/evidence/README.md).

## How it works

1. A merchant creates a fixed or variable capped payment product and generates a checkout link.
2. The consumer connects Freighter or xBull and authorizes a mandate with explicit limits.
3. The merchant submits a bounded charge authorization.
4. The relayer simulates and submits the transaction, but has no authority over the mandate or user funds.
5. The Soroban contract enforces the amount, period, interval, charge count, expiry, pause, and revocation rules.
6. The consumer can inspect the live mandate, pause it, resume it, or cancel it permanently.

The canonical demo runs a successful charge, rejects an over-limit charge, revokes the mandate, and rejects a later charge attempt:

```bash
pnpm demo:scenes
```

See the full walkthrough in [`docs/demo-script.md`](docs/demo-script.md).

## Deployed testnet contract

| Item | Value |
| --- | --- |
| Network | Stellar testnet |
| Mandate registry | `CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22` |
| Optimized Wasm SHA-256 | `8b4f68e3f1ecb259d7cbb7153032ac8afbd279d1c5d4eb82ee0896c935e2832c` |
| Demo asset | PUSD, 7 decimals |
| PUSD Stellar Asset Contract | `CB223VUC7MMCFT352EO7QLLV6QWHXTDOXOHY2BW7DZTO3VXBXAI7DUZJ` |
| Deployment record | [`deployments/testnet.json`](deployments/testnet.json) |

The deployment uses a real Stellar Asset Contract with SEP-41 semantics, not only a local mock token.

## Local development

Prerequisites: Node 22+, pnpm 10.12.1, Rust, Stellar CLI 23+, Docker, and Freighter or xBull configured for testnet.

```bash
pnpm install --frozen-lockfile
pnpm demo:setup
pnpm start
```

Open [http://localhost:3000](http://localhost:3000). `demo:setup` creates a local `.env`, starts Postgres and Redis, runs migrations, builds the workspaces, funds demo identities, creates PUSD trustlines, and seeds merchant, consumer, product, and checkout data. It refuses to overwrite an existing `.env`.

For a clean real-testnet demo, run this in another shell:

```bash
pnpm demo:scenes
```

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:e2e:system
pnpm build

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The system E2E suite proves checkout, charge, signed webhook delivery, payment history, revocation, allowance removal, and typed `MandateRevoked` rejection against the committed testnet deployment.

## Architecture and security

The Soroban contract is the policy authority. API, database, and relayer state cannot override mandate limits or revocation. Merchants authorize an exact, bounded Soroban invocation; the relayer pays network fees and submits it without holding a merchant secret or user key.

The repository contains:

- `contracts/mandate-registry` — Soroban mandate policy contract.
- `packages/contract-client` — generated bindings and typed domain facade.
- `packages/stellar` — simulation, signing, submission, and error decoding.
- `apps/web` — consumer checkout, mandate controls, and merchant dashboard.
- `apps/api` — merchant API, authentication, idempotency, webhooks, and payments.
- `apps/relayer` — guarded charge execution and retry pipeline.

Read the detailed [architecture](docs/architecture.md), [merchant API](docs/merchant-api.md), [threat model](docs/threat-model.md), and [operations guide](docs/operations.md).

## Scope and roadmap

This MVP is testnet-only. Deferred ideas—including metered billing, passkeys, cross-asset conversion, anchor integrations, x402/MPP billing, and mainnet deployment—are tracked in [`docs/roadmap.md`](docs/roadmap.md).
