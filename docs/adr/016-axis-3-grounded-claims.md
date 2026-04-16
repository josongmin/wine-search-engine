# ADR-016 — Axis 3: grounded claim emission in the V2 sidecar

**Status**: Decommissioned.
**Implemented**: 2026-04-15.
**Removed from runtime**: 2026-04-16.

This ADR is kept as a tombstone so historical references from ADR-017 and
session-scoped plans do not break.

## Summary

Axis 3 proposed an optional grounded-claim sidecar on machine V2
responses, along with a dedicated emitter, verifier stack, schema-lock
tests, and shadow-parity harness.

That stack has been removed from the live codebase. The following no
longer exist in runtime:

- grounded-claim emitter and prompt
- grounded-claim / atomic-claim model layer
- GCE feature flags and coherence rules
- atomic-claim verifier router and per-type verifiers
- gold-claim bootstrap corpus and shadow-parity harness
- machine-response V2 `grounded` / `claimSchemaVersion` surface

## Current state

The live system continues to use the legacy deterministic
`claim-extractor.ts` and `claim-level-evaluator.ts` path for answer
faithfulness and claim scoring.

This file is historical only. It is not a specification for current
runtime behaviour.
  enforces the mapping.
- **`toolCallId` drift** — emitter validates against frame-set, drops
  unknown IDs with explicit degradation reason.
- **Extractor deletion premature** — CI guard blocks until gate 1 + 3
  green.

---

## 7. References

- RFC-020 (claim categories).
- ADR-009 (evidence frames v1.1).
- ADR-015 (critic signals).
- CLAUDE.md rules 10, 12 (LLM number-as-string, `JSON.parse` hygiene).
