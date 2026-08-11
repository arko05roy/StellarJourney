# Threat Model

This document will enumerate the trust assumptions and attack surfaces of Stellar Mandates —
a malicious or compromised relayer, a malicious merchant, a malicious token contract, replay
and idempotency-key abuse, concurrent-worker races, and stale-simulation submission — each
mapped to a mitigation and the adversarial test that proves it (PLAN.md §19-20).

Status: stub, filled in Phase 14 (security hardening).
