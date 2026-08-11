# Security Checklist

Review date: 2026-07-29. Scope: Phase 16 production-readiness code and PLAN §§19–21.

## Gate

Open critical findings: **0**
Open high findings: **0**

| Area                                           | Severity           | Status | Evidence                                                                   |
| ---------------------------------------------- | ------------------ | ------ | -------------------------------------------------------------------------- |
| Contract auth, replay, caps, atomic accounting | Critical if broken | Closed | Rust unit, adversarial, and property suites; `docs/contract-invariants.md` |
| Relayer amount/asset/destination tampering     | Critical if broken | Closed | `apps/relayer/src/pipeline.test.ts` mismatch suite                         |
| Charge/revoke and period races                 | High if broken     | Closed | `contracts/mandate-registry/src/test_adversarial.rs`                       |
| Duplicate workers                              | High if broken     | Closed | Real-Postgres two-worker pipeline test                                     |
| Webhook spoofing/replay                        | High if broken     | Closed | Shared + SDK signature suites                                              |
| Webhook repeated errors                        | Medium             | Closed | Six attempts then one dead-letter test                                     |
| SSRF via webhook URL                           | High if broken     | Closed | URL guard tests; redirects not followed                                    |
| Embedded/logged secrets or key crossover       | High if broken     | Closed | `pnpm security:audit`; logger redaction tests                              |
| Sensitive-route abuse                          | High if unlimited  | Closed | Burst-load cases in `apps/api/src/security-hardening.test.ts`              |
| Required structured correlation                | Medium             | Closed | API/relayer log fields + `secure-logger.test.ts`                           |
| PLAN §21 signals                               | Medium             | Closed | `observability.test.ts`; pipeline/webhook/indexer wiring                   |
| Merchant authorization transport               | Critical if broken | Closed | exact-XDR validation + API/SDK/relayer tests                               |
| Scoped API-key permissions                     | High if bypassed   | Closed | route scope wiring + API-key integration tests                             |
| Metrics persistence and alert rules            | Medium             | Closed | Prometheus/Alertmanager config validation                                  |

## Residual findings

### Remaining operational items

- Email alert delivery is intentionally deferred; Alertmanager currently records alerts without
  an SMTP receiver.
- Merchant bootstrap is unauthenticated and rate-limited. Add business verification before
  opening production onboarding.
- `AUTHORIZATION_ENCRYPTION_KEY` rotation needs a dual-key migration procedure while pending
  authorizations exist.

## Reproduction

```bash
pnpm security:audit
pnpm --filter @paymap/api test
pnpm --filter @paymap/relayer test
pnpm --filter @paymap/api lint
pnpm --filter @paymap/relayer lint
pnpm --filter @paymap/api typecheck
pnpm --filter @paymap/relayer typecheck
cargo test --workspace
```
