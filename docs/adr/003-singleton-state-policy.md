# ADR-003: Singleton Service State Policy

## Status: Accepted

## Context

The `Ranker` class stored ranking metadata in mutable instance fields (`_lastCoarsePruneSummary`, `_lastRerankExecuted`, etc.) that were read via getters after `rank()` returned. Since `rank()` contains an `await` (reranker HTTP call), two concurrent requests sharing the singleton Ranker could observe each other's metadata — a race condition that corrupted observability data and could poison cache decisions.

## Decision

**Singleton services (wired once in the DI container, shared across all requests) MUST be stateless.** Specifically:

1. **No mutable instance fields** that carry per-request data. All per-request state must be returned from the method call, not stored on the instance.
2. **`readonly` on all instance fields** — enforced by `@typescript-eslint/prefer-readonly` in strict config.
3. **If an `await` exists inside a method**: the method MUST NOT read or write instance fields that could be accessed by another concurrent invocation between the `await` and the return.
4. **Acceptable singleton state**: configuration (set once at construction, never mutated), caches with atomic read/write (e.g., `Map` with single-key operations), counters with `++` (monotonic, no read-modify-write races in single-threaded JS).

## Applied Fix

The Ranker now returns `RankingOutput { results, metadata }` from `rank()`. The `RankingStagePipeline` reads metadata from the return value, not from getters. All `_last*` fields and their getters were deleted.

## Consequences

- New domain services wired as singletons must document their statefulness in the class JSDoc
- Services that need per-request state must either (a) return it from methods or (b) be instantiated per-request
- A meta-test could enforce this by scanning singleton wiring in `container-core.ts` and asserting all fields are `readonly` — deferred to a future sprint
