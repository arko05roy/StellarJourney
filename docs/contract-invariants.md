# Contract Invariants

This document will enumerate every mandatory security invariant from CLAUDE.md §7
(authorization, amounts, time, replay resistance, state, tokens) and map each one to the
specific test that proves it holds, including the property-based adversarial suite run
against a malicious token contract.

Status: stub, filled in Phase 6 (invariant and property tests) and kept current through
Phase 14 (security hardening).
