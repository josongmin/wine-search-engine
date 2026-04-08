# ADR-002: Error Handling Tiers

## Status: Accepted

## Context

During bugbash we found the main search pipeline fabricating HTTP 200 responses from unexpected errors (OOM, Redis down, nil deref). This hid infrastructure failures behind success status codes, blinding monitoring, SLOs, and client retry logic.

## Decision

Three error-handling tiers with distinct rules:

### Tier 1: Infrastructure / Sidecar (cache, telemetry, metrics)
- **Rule**: Catch, log, degrade gracefully, continue
- **Example**: `CacheService.getSearchResponse` catches Redis errors → returns cache miss
- **Rationale**: A cache failure should never block a search

### Tier 2: Use Case / Application (search, hybrid, batch, agent)
- **Rule**: Catch ONLY enumerated, expected errors. Unknown errors MUST throw to the HTTP layer.
- **Prohibited**: `catch { return fabricatedSuccessResponse }` for unknown errors
- **Example**: `SearchUseCase` catches `DomainError` subtypes for specific handling, re-throws everything else as `DomainError('INTERNAL_INCONSISTENCY', ...)`
- **Rationale**: A pipeline crash is a 500, not a 200 with `decisionStatus: 'failed'`

### Tier 3: HTTP / Route Handler (Fastify error handler)
- **Rule**: Map every error to the RFC-014 error envelope shape `{ error: { request_id, code, message, failure_reason, retryable } }`. Never leak internal error messages to clients.
- **Example**: `error-handler.ts` maps `DomainError` codes to HTTP status codes
- **Rationale**: Clients need a consistent error contract regardless of the failure source

## Consequences

- The outer catch-alls in `search.usecase.ts` and `hybrid.usecase.ts` now throw instead of fabricating 200 responses
- `post-route-phase.ts` no longer catches `decisionEngine.decide()` errors
- Every new use case must follow Tier 2 rules (enforced via code review + `no-catch-fabricate-success` convention in CLAUDE.md)
