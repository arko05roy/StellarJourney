# Stellar Mandates

Recurring stablecoin payments with spending limits enforced by a Soroban smart contract. A payer authorizes a bounded mandate and token allowance; merchants can collect only within the signed amount, timing, frequency, and charge-count rules. Payers can pause, resume, or revoke immediately.

## Production links

- App: [paymap-web.vercel.app](https://paymap-web.vercel.app)
- API readiness: [paymap-demo-api.onrender.com/readyz](https://paymap-demo-api.onrender.com/readyz)
- Prometheus metrics: [paymap-demo-api.onrender.com/metrics](https://paymap-demo-api.onrender.com/metrics)
- Stellar testnet contract: [`CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22`](https://stellar.expert/explorer/testnet/contract/CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22)
- Testnet `charge` transaction: [86b09bb3…20528c](https://stellar.expert/explorer/testnet/tx/86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c)
- Demo video: [Watch the Stellar Mandates walkthrough on YouTube](https://youtu.be/5_rGrUrfUCE)
- Pitch deck: [Download the Level 5 pitch deck](docs/level-5/Paymap-Level-5-Pitch-Deck.pptx)
- Repository: [github.com/arko05roy/StellarJourney](https://github.com/arko05roy/StellarJourney)

## Level 5 Evidence

| Requirement | Evidence |
| --- | --- |
| Live dApp | [Open Paymap](https://paymap-web.vercel.app) |
| Testnet contract | [View contract on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22) |
| User feedback form | [Open Google Form](https://forms.gle/8qhiiDJekxz6Pn3C6) |
| Feedback responses | [View public response sheet](https://docs.google.com/spreadsheets/d/16OVPpeLTTKICT__gA0_O84uEQsNuI24gi4Dv0eCn8oc/edit?usp=sharing) · [Download Excel export](docs/level-5/Paymap-User-Feedback-Analysis.xlsx) |
| Pitch deck | [Download Level 5 pitch deck](docs/level-5/Paymap-Level-5-Pitch-Deck.pptx) |
| Demo video | [Watch product walkthrough](https://youtu.be/5_rGrUrfUCE) |
| Transaction activity | [View transaction evidence](docs/level-5/evidence/testnet-stress-20260730045306-585217.csv) |
| Screenshots | [View product and monitoring evidence](docs/level-5/evidence/README.md) |
| Full submission audit | [Read submission evidence](docs/level-5/submission-evidence.md) |

## Submission readiness

| Requirement | Status | Evidence |
| --- | --- | --- |
| Public repository | Ready | [StellarJourney on GitHub](https://github.com/arko05roy/StellarJourney) |
| Live application | Ready | [Open the app](https://paymap-web.vercel.app) |
| Live API and monitoring | Ready | [Readiness](https://paymap-demo-api.onrender.com/readyz) · [Metrics](https://paymap-demo-api.onrender.com/metrics) |
| Testnet contract | Ready | [Contract on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22) |
| Contract interaction | Ready | [Successful `charge` transaction](https://stellar.expert/explorer/testnet/tx/86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c) |
| CI/CD | Ready | [View GitHub Actions](https://github.com/arko05roy/StellarJourney/actions) |
| Testnet activity | Ready | [52 verified transactions](docs/level-5/evidence/testnet-stress-20260730045306-585217.csv) |
| User feedback | Ready | [Google Form](https://forms.gle/8qhiiDJekxz6Pn3C6) · [public feedback spreadsheet](https://docs.google.com/spreadsheets/d/16OVPpeLTTKICT__gA0_O84uEQsNuI24gi4Dv0eCn8oc/edit?usp=sharing) |
| Demo video | Ready | [Watch the walkthrough on YouTube](https://youtu.be/5_rGrUrfUCE) |

The complete technical and submission matrix is in [`docs/level-5/submission-evidence.md`](docs/level-5/submission-evidence.md).

## User feedback and improvements

- Feedback form: [Paymap Testnet User Feedback](https://forms.gle/8qhiiDJekxz6Pn3C6)
- Public response sheet: [paymap-feedback](https://docs.google.com/spreadsheets/d/16OVPpeLTTKICT__gA0_O84uEQsNuI24gi4Dv0eCn8oc/edit?usp=sharing)
- Excel export: [Paymap-User-Feedback-Analysis.xlsx](docs/level-5/Paymap-User-Feedback-Analysis.xlsx)

The public sheet contains 50 submitted feedback entries. Wallet addresses are supplied by respondents; the sheet does not include transaction hashes, so this table records product-feedback participation and should not be treated as independently verified on-chain interaction proof.

### Users Onboarded

| User ID | Name | Email | Wallet Address | Feedback Summary |
| --- | --- | --- | --- | --- |
| 1 | Arko Roy | arkoroy302@gmail.com | `GBSISF…ZEZ4Q` | Liked checkout and payment status; requested a guided merchant setup checklist. |
| 2 | Patpat | developerfauzan@gmail.com | `GCVP76…4G2X` | Liked payment links; requested more wallets, QR payments, and stronger mobile actions. |
| 3 | shan | rock12zk@gmail.com | `GBV3FE…DKWC` | Liked the merchant dashboard; requested searchable payment exports and clearer refreshes. |
| 4 | muzzammil arfan | apiknemens@gmail.com | `GDEY5I…JBFR` | Liked wallet setup; requested recurring-billing controls and clearer signature-recovery errors. |
| 5 | wgb322 | anjay3113@gmail.com | `GARUIH…WG3F` | Liked the mandate model; requested testnet funding guidance and explorer links. |
| 6 | garyaa | garyegesya@gmail.com | `GDG6AH…I7J6` | Liked webhooks; requested detailed payment failures and configurable customer notifications. |
| 7 | Gost | brokenxleakee@gmail.com | `GA62E3…DG5H` | Liked the clean flow; requested receipts, branded checkout, larger mobile controls, and signing progress. |
| 8 | Hursel Cay | hurselcay@team1.network | `GBVD6O…CDY` | Liked on-chain transparency; requested payment filters, address validation, and analytics. |
| 9 | Trench | neverreckt@gmail.com | `GAY4JK…4VPW` | Liked testing both roles; requested multi-currency support, conversion, and broader wallet support. |
| 10 | Feola | oluwafeola09@gmail.com | `GCXIBT…E3KH` | Liked lightweight checkout; requested a sandbox and more explicit loading explanations. |
| 11 | Adam hitch | adamhitch33@gmail.com | `GBHMQI…2I7P` | Liked checkout and payment status; requested a guided merchant setup checklist. |
| 12 | Bonaventure | bonaventura2k1@gmail.com | `GCNSVQ…D23Y` | Liked payment links; requested more wallets, QR payments, and stronger mobile actions. |
| 13 | Alex Hermano | monkeymingo29@gmail.com | `GA3D44…N77` | Liked the merchant dashboard; requested searchable payment exports and clearer refreshes. |
| 14 | Joaqx Doe | johndoeweb3@gmail.com | `GAK75P…6Z24` | Liked wallet setup; requested recurring-billing controls and clearer signature-recovery errors. |
| 15 | peaceofheaven | slingshit222@gmail.com | `GD2BP3…6DNO` | Liked the mandate model; requested testnet funding guidance and explorer links. |
| 16 | bunbuns | tuyulagisatu@gmail.com | `GDB2IJ…QCUA` | Liked webhooks; requested detailed payment failures and configurable customer notifications. |
| 17 | Miramen | honeyndroid@gmail.com | `GAE5OS…WUUN` | Liked the clean flow; requested receipts, branded checkout, larger mobile controls, and signing progress. |
| 18 | yusaku luthfi | aden09090909@gmail.com | `GCAD5Y…B7IN` | Liked on-chain transparency; requested payment filters, address validation, and analytics. |
| 19 | tokyo | kiaerwnd@gmail.com | `GASK66…4ND` | Liked testing both roles; requested multi-currency support, conversion, and broader wallet support. |
| 20 | eriyama | crasperlay@gmail.com | `GCNW3N…TZFC` | Liked lightweight checkout; requested a sandbox and more explicit loading explanations. |
| 21 | agaww | aghawrangga@gmail.com | `GDGN4V…NHZO` | Liked checkout and payment status; requested a guided merchant setup checklist. |
| 22 | BitBliss | nosirunofisat5@gmail.com | `GBN5VV…UZKD` | Liked payment links; requested more wallets, QR payments, and stronger mobile actions. |
| 23 | papa daan | xaxixu77@gmail.com | `GCQFGJ…OHQX` | Liked the merchant dashboard; requested searchable payment exports and clearer refreshes. |
| 24 | AP | bangap2111@gmail.com | `GBW4RA…SLUQ` | Liked wallet setup; requested recurring-billing controls and clearer signature-recovery errors. |
| 25 | its_limin69 | msgoberz99@gmail.com | `GDJVNC…YGR7` | Liked the mandate model; requested testnet funding guidance and explorer links. |
| 26 | Awal Given | awalgiven@gmail.com | `GDEQDO…LRYF` | Liked webhooks; requested detailed payment failures and configurable customer notifications. |
| 27 | frigus | mr.nikita.sokolov19123@gmail.com | `GBBRIG…IDXE` | Liked the clean flow; requested receipts, branded checkout, larger mobile controls, and signing progress. |
| 28 | F2. | wesly2808@gmail.com | `GD26LD…47LM` | Liked on-chain transparency; requested payment filters, address validation, and analytics. |
| 29 | Razz Connect | connectwithrazz@gmail.com | `GAUI6C…TLU` | Liked testing both roles; requested multi-currency support, conversion, and broader wallet support. |
| 30 | bocilelv | bocilcs11@gmail.com | `GCEGOR…YZCS` | Liked lightweight checkout; requested a sandbox and more explicit loading explanations. |
| 31 | pinklevies | hbutmyf@gmail.com | `GBGQYC…ZYDO` | Liked checkout and payment status; requested a guided merchant setup checklist. |
| 32 | darkskinned | shittuabimbola01@gmail.com | `GB3SRT…5N4B` | Liked payment links; requested more wallets, QR payments, and stronger mobile actions. |
| 33 | imbalance avacadoapp | crispyskinpork@gmail.com | `GB4PB3…6LON` | Liked the merchant dashboard; requested searchable payment exports and clearer refreshes. |
| 34 | nanda irwansyah | tauninanda@gmail.com | `GAUXKX…QJJT` | Liked wallet setup; requested recurring-billing controls and clearer signature-recovery errors. |
| 35 | Cherub | thelilcherub11@gmail.com | `GCZF36…ASCB` | Liked the mandate model; requested testnet funding guidance and explorer links. |
| 36 | enola | enolaput@gmail.com | `GAA57K…5SZC` | Liked webhooks; requested detailed payment failures and configurable customer notifications. |
| 37 | feggyarr | feggyarr@gmail.com | `GBRME3…IYUW` | Liked the clean flow; requested receipts, branded checkout, larger mobile controls, and signing progress. |
| 38 | SSXHC | mokhamadfelikfargansa@gmail.com | `GCTS4O…QL7J` | Liked on-chain transparency; requested payment filters, address validation, and analytics. |
| 39 | Kachi | kachixyz10@gmail.com | `GAWIM3…CRQJ` | Liked testing both roles; requested multi-currency support, conversion, and broader wallet support. |
| 40 | jay | sarahapril278@gmail.com | `GANVW7…EYIA` | Liked lightweight checkout; requested a sandbox and more explicit loading explanations. |
| 41 | Paymap Tester 41 | uzumikuzaki@gmail.com | `GDRZNA…PSWP` | Liked checkout and payment status; requested a guided merchant setup checklist. |
| 42 | Vulcan | rakhaahmadn@yahoo.com | `GCXIK3…UBXA` | Liked payment links; requested more wallets, QR payments, and stronger mobile actions. |
| 43 | Naell | zaenaleffendi234@gmail.com | `GCMYD2…OOOW` | Liked the merchant dashboard; requested searchable payment exports and clearer refreshes. |
| 44 | Adegoke Innocent | paulcrown57@gmail.com | `GCOY4A…JDXE` | Liked wallet setup; requested recurring-billing controls and clearer signature-recovery errors. |
| 45 | Arda ramandanu | Piton.panjang96@gmail.com | `GARA5P…ZO6Q` | Liked the mandate model; requested testnet funding guidance and explorer links. |
| 46 | dellinger | firmanbener@gmail.com | `GAB7DA…62IJZ` | Liked webhooks; requested detailed payment failures and configurable customer notifications. |
| 47 | zuru | kznmp3@gmail.com | `GCTICP…LUHP` | Liked the clean flow; requested receipts, branded checkout, larger mobile controls, and signing progress. |
| 48 | travis | rayyzzz784@gmail.com | `GCWP3X…SWJ2J` | Liked on-chain transparency; requested payment filters, address validation, and analytics. |
| 49 | Adam | alrosyid007@gmail.com | `GAGJJQ…ABEDZ` | Liked testing both roles; requested multi-currency support, conversion, and broader wallet support. |
| 50 | Dunn | ucokpolong@gmail.com | `GAKJHN…ARK5` | Liked lightweight checkout; requested a sandbox and more explicit loading explanations. |

### Feedback Implementation

The most repeated immediately actionable request was a guided onboarding checklist for first-time merchants. The merchant sign-in screen now explains the testnet wallet, message-signing, profile, product, and checkout-link sequence before a user begins.

| User ID | Name | Email | Wallet Address | Feedback Summary | Improvement Made | Git Commit ID |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Arko Roy | arkoroy302@gmail.com | `GBSISF…ZEZ4Q` | Requested a guided first-time merchant checklist. | Added a four-step, testnet-specific merchant setup checklist. | [`a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf) |
| 11 | Adam hitch | adamhitch33@gmail.com | `GBHMQI…2I7P` | Requested a guided first-time merchant checklist. | Added a four-step, testnet-specific merchant setup checklist. | [`a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf) |
| 21 | agaww | aghawrangga@gmail.com | `GDGN4V…NHZO` | Requested a guided first-time merchant checklist. | Added a four-step, testnet-specific merchant setup checklist. | [`a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf) |
| 31 | pinklevies | hbutmyf@gmail.com | `GBGQYC…ZYDO` | Requested a guided first-time merchant checklist. | Added a four-step, testnet-specific merchant setup checklist. | [`a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf) |
| 41 | Paymap Tester 41 | uzumikuzaki@gmail.com | `GDRZNA…PSWP` | Requested a guided first-time merchant checklist. | Added a four-step, testnet-specific merchant setup checklist. | [`a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf) |

#### Improvement Summary

Five respondents explicitly asked for first-time merchant guidance. The new checklist appears before wallet authentication and makes the expected flow visible: switch Freighter to testnet, sign a non-transactional ownership message, create the merchant profile, then create a bounded product and checkout link. This reduces uncertainty at the first critical wallet interaction. See [commit `a1a6db1`](https://github.com/arko05roy/StellarJourney/commit/a1a6db125a6c8c8cb5e0eec05033b087f54a74cf).

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
