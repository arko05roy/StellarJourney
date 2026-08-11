# Paymap Submission Evidence

Audit date: 2026-07-30.

Current verdict: the technical product, deployments, contract, CI/CD, tests, deck, and screenshots
are ready. Level 4 and Level 5 are **not fully cleared** until genuine user, feedback, video, and
review evidence is supplied.

## Level 4

| Requirement                               | Status             | Evidence                                                                                                                               |
| ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Fully functional production-ready MVP     | Ready              | [Live frontend](https://paymap-web.vercel.app) · [live API](https://paymap-demo-api.onrender.com/readyz)                               |
| Stable frontend and contract architecture | Ready              | [`architecture.md`](../architecture.md) · [`contract-invariants.md`](../contract-invariants.md)                                        |
| Mobile responsive UI                      | Ready              | [`product-ui-mobile.png`](evidence/product-ui-mobile.png)                                                                              |
| Loading states and error handling         | Ready              | Route `loading.tsx` / `error.tsx`, checkout state machine, dashboard skeletons, typed error tests                                      |
| Minimum 10 real users                     | **Pending**        | Requires 10 genuine respondents with verified wallet interactions                                                                      |
| Wallet-interaction proof                  | **Pending cohort** | Technical transactions exist, but controlled wallets do not prove real users                                                           |
| Basic user feedback collection            | **Pending**        | Form specification is ready; Google Form and responses are not                                                                         |
| Production deployment                     | Ready              | Vercel frontend and Render API/relayer                                                                                                 |
| Monitoring and analytics integration      | Ready              | [Live Prometheus endpoint](https://paymap-demo-api.onrender.com/metrics) · [`monitoring-metrics.png`](evidence/monitoring-metrics.png) |
| Optimized UX                              | Ready technically  | Responsive landing page, wallet-first merchant onboarding, retry/loading/error states                                                  |
| Project structure and documentation       | Ready              | Monorepo workspaces, [`README.md`](../../README.md), architecture, operations, security, API docs                                      |
| Contract on Stellar testnet               | Ready              | `CCK2CG2DOZ7II4DTTNABU54F3OFMMJRKNABXLPTWINKXPWNMS2Q3XR22`                                                                             |
| 15+ meaningful commits                    | Ready              | 38 commits existed before this audit                                                                                                   |
| Public repository                         | Ready              | <https://github.com/SachPlayZ/Paymap>                                                                                                  |
| Live demo                                 | Ready              | <https://paymap-web.vercel.app>                                                                                                        |
| Demo video                                | **Pending**        | [`demo-script.md`](../demo-script.md) is ready; public recording URL required                                                          |
| Team review                               | **Pending**        | [`team-review.md`](../team-review.md) requires reviewer scores and sign-off                                                            |
| Required screenshots                      | Ready              | Product, mobile, monitoring, CI, tests, and transaction screenshots below                                                              |

## Level 5

| Requirement                                              | Status                | Evidence                                                                                                                          |
| -------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Minimum 50 testnet users                                 | **Pending**           | Workbook currently reports 0; controlled stress accounts are excluded                                                             |
| Real transaction activity                                | Ready technically     | [`52-transaction CSV`](evidence/testnet-stress-20260730045306-585217.csv)                                                         |
| Active real-user usage proof                             | **Pending**           | Each respondent must supply a wallet and successful testnet hash                                                                  |
| Features based on user feedback                          | **Pending**           | Requires genuine responses before selecting an iteration                                                                          |
| UX/UI and stability improvements                         | Ready                 | Landing redesign, wallet authentication, production-readiness, and CI repair commits                                              |
| Optimized onboarding                                     | Ready technically     | Wallet ownership challenge precedes merchant setup; checkout has explicit recovery states                                         |
| Professional pitch deck                                  | Ready                 | [`Paymap-Level-5-Pitch-Deck.pptx`](Paymap-Level-5-Pitch-Deck.pptx)                                                                |
| Problem, solution, market, architecture, growth, roadmap | Ready                 | Slides 2, 3, 7, 5, 7, and 8 respectively                                                                                          |
| Full product walkthrough video                           | **Pending**           | Record and publish [`demo-script.md`](../demo-script.md)                                                                          |
| 20+ meaningful commits                                   | Ready                 | 38 commits existed before this audit                                                                                              |
| Updated documentation                                    | Ready                 | Root README and `docs/`                                                                                                           |
| Google Form                                              | **Pending sign-in**   | Build from [`google-form-spec.md`](google-form-spec.md)                                                                           |
| Excel response export                                    | **Pending responses** | [`Paymap-User-Feedback-Analysis.xlsx`](Paymap-User-Feedback-Analysis.xlsx) is a validated template with 0 rows, not an export     |
| README workbook link                                     | Ready                 | Workbook is linked with its template status disclosed                                                                             |
| Next-phase improvement plan                              | Ready                 | README feedback plan                                                                                                              |
| Feedback improvement commit link                         | **Pending feedback**  | Evidence workflow commit [`adf30fd`](https://github.com/SachPlayZ/Paymap/commit/adf30fd); product iteration commit still required |
| Analytics or transaction screenshots                     | Ready                 | Monitoring and successful transaction screenshots below                                                                           |
| User feedback iteration summary                          | **Pending responses** | Do not infer themes before responses exist                                                                                        |

## Advanced technical requirements

| Requirement                           | Status | Evidence                                                                                                                      |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Advanced smart contract development   | Ready  | Bounded mandates, lifecycle, accounting, refunds, replay protection, property tests                                           |
| Inter-contract communication          | Ready  | Mandate registry invokes the Stellar Asset Contract for `transfer_from` / `transfer`                                          |
| Event streaming and real-time updates | Ready  | Durable Soroban `getEvents` indexer with cursor, deduplication, ordering, and retention-gap handling                          |
| CI/CD pipeline                        | Ready  | [`ci.yml`](../../.github/workflows/ci.yml) · [green main run](https://github.com/SachPlayZ/Paymap/actions/runs/30532887659)   |
| Smart-contract deployment workflow    | Ready  | [`deploy-testnet.ts`](../../scripts/deploy-testnet.ts) · [`testnet.json`](../../deployments/testnet.json)                     |
| Mobile responsive frontend            | Ready  | [`product-ui-mobile.png`](evidence/product-ui-mobile.png)                                                                     |
| Error handling and loading states     | Ready  | Typed contract/API errors, route boundaries, skeletons, pending controls, retries                                             |
| Contract and frontend tests           | Ready  | 640 Node tests in the full gate; 133 frontend tests shown below; Rust workspace tests in CI                                   |
| Production-ready architecture         | Ready  | Non-custodial authority boundary, scoped API keys, encrypted authorizations, queues, metrics, alerts                          |
| Documentation and presentation        | Ready  | README, architecture, invariants, operations, threat model, demo script, pitch deck                                           |
| Transaction hash                      | Ready  | [`86b09…20528c`](https://stellar.expert/explorer/testnet/tx/86b09bb3febcef33ed26c7d7a85a2d91a62b2f80048347e365df6c93ca20528c) |

## Screenshots

- [Production desktop UI](evidence/product-ui-desktop.png)
- [Mobile responsive UI](evidence/product-ui-mobile.png)
- [Wallet-first merchant onboarding](evidence/merchant-wallet-onboarding.png)
- [Green CI/CD workflow](evidence/ci-main-green.png)
- [Frontend test output — 133 passing](evidence/test-output.png)
- [Live Prometheus metrics](evidence/monitoring-metrics.png)
- [Successful testnet charge](evidence/testnet-charge-transaction.png)

## Genuine user evidence workflow

1. Create the Google Form from [`google-form-spec.md`](google-form-spec.md).
2. Have each tester complete a real product flow and submit their wallet plus transaction hash.
3. Verify every hash in Horizon/Stellar Expert before counting that respondent.
4. Export Google Forms responses to Excel; keep the raw export private.
5. Copy genuine rows into the workbook and publish only a redacted export or aggregate screenshot.
6. Group feedback, rank themes by frequency/severity, implement the top issue, and link its commit.

Never infer users from addresses or transaction counts. Keep names/emails private.

## Remaining external actions

1. Sign in to Google and create/share the form.
2. Onboard 10 genuine users for Level 4, then 50 for Level 5.
3. Export and analyze their responses.
4. Implement one feedback-driven improvement and add its commit link.
5. Obtain team-review scores/sign-off.
6. Record the 1–2 minute walkthrough, upload it, and add the public URL.
