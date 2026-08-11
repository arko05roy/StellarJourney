# Submission Screenshot Provenance

Captured on 2026-07-30 from public deployment and repository state.

| File                             | Source                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `product-ui-desktop.png`         | `https://paymap-web.vercel.app/`, Chromium 1440×900                                    |
| `product-ui-mobile.png`          | `https://paymap-web.vercel.app/`, Chromium 390×844 with a mobile user agent            |
| `merchant-wallet-onboarding.png` | `https://paymap-web.vercel.app/merchant/connect`, Chromium 1440×900                    |
| `ci-main-green.png`              | Public GitHub Actions run `30532887659`                                                |
| `test-output.png`                | Real `pnpm --filter @paymap/web test -- --reporter=verbose` output at commit `ff9f536` |
| `monitoring-metrics.png`         | Live `https://paymap-demo-api.onrender.com/metrics` response                           |
| `testnet-charge-transaction.png` | Stellar Expert testnet transaction `86b09…20528c`                                      |

The test screenshot is a browser rendering of captured terminal output for legibility; the command
exited successfully with 20 test files and 133 tests passing. The public CI run independently
executes the complete Node and Rust gates.
