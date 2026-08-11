# Operations

## Free demo deployment

Use `render.free.yaml` for a no-card demo backend. It runs the API and relayer
in one free web service so both wake together after idle spin-down. Deploy the
frontend separately on Vercel with
`NEXT_PUBLIC_API_URL=https://paymap-demo-api.onrender.com`.

This topology is for demos only: Render free web services sleep after idle,
free Key Value is non-persistent, and free Postgres expires after 30 days
without backups. Use `render.yaml` for production-like staging.

## Staging

Render Blueprint: `render.yaml`. Render supplies HTTPS `*.onrender.com` hostnames; custom domains
are optional.

Before first deploy, set `RELAYER_SECRET_KEY` on `paymap-relayer-staging`. Use a dedicated,
funded Stellar testnet account. Never reuse a merchant or production signer.

The API runs Prisma migrations as its Render pre-deploy command. Postgres and Key Value are private.
Prometheus stores 30 days on a persistent disk. Grafana is the only public monitoring service;
rotate its generated admin password after first login.

## Health and metrics

- API: `/healthz`, `/readyz`, `/metrics`
- Relayer private service: `/healthz`, `/readyz`, `/metrics`
- Grafana: `/api/health`

Metrics use bounded route/outcome/reason labels. No merchant, mandate, charge, transaction, URL,
secret, or raw-error labels are emitted.

## Alert delivery

Alertmanager currently uses the `email-later` receiver with no SMTP destination, per the staging
decision. Add SMTP credentials through Render secret storage and update
`ops/alertmanager/alertmanager.yml` before production.

## Load test

Safe defaults: GET only, 30 seconds, concurrency 10, at most 2,000 requests.

```bash
LOAD_TARGET_URL=https://paymap-api-staging.onrender.com \
  pnpm test:load:staging
```

For authenticated reads, provide `LOAD_API_KEY` through the shell environment. The runner refuses
non-local/non-Render hosts unless `LOAD_ALLOW_ANY_HOST=1` is explicit.

## Failure drills

Run on staging or local Docker only:

1. Redis restart during queued work: restart Key Value/Redis; verify `/readyz` fails then recovers,
   no duplicate payment, queue depth returns to zero.
2. Relayer termination during `processing`, `simulated`, and `submitted`: restart service; verify
   guarded state transitions prevent duplicate success.
3. RPC timeout/5xx: point a disposable staging deployment at a fault proxy; verify retry alert,
   bounded backoff, and no optimistic `Payment`.
4. Postgres interruption: suspend DB briefly; verify readiness failure, recovery, and no partial
   terminal state.
5. Webhook 5xx/timeout: use a controlled receiver; verify retry schedule, dead letter, and alert.
6. Expired authorization: complete an expired challenge; verify stable rejection and no queue job.
7. Indexer lag: stop relayer for more than 120 ledgers; verify alert and cursor recovery.

Record timestamps, alert firing/resolution, p95/p99 latency, queue recovery time, and any manual
intervention. Never inject failures into production.

## Rollback

Deploy the prior Render image/commit. Database migrations in Phase 16 are additive; old rows remain
readable. Do not roll back by deleting authorization or scope columns. Restore Postgres only for
confirmed data corruption, using Render point-in-time recovery.
