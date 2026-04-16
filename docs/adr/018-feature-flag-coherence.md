# ADR-018: Feature flag coherence validator (Wave F3)

- Status: Accepted
- Date: 2026-04-15
- Supersedes: —
- Related: ADR-010 (Phase 1a ConstraintCompiler), ADR-012 (Phase 1b.2 topology planner), ADR-013 (Phase 1c BundleSelector), ADR-015 (Axis 2 retrieval critic), ADR-017 (SOTA train post-mortem)

## Context

The SOTA train (ADRs 010-015) introduced four process-level env flags that gate interlocking stages of the retrieval pipeline:

| Flag | Default | ADR |
|---|---|---|
| `CONSTRAINT_GRAPH_EMIT` | on | 010 |
| `CONSTRAINT_GRAPH_TOPOLOGY_LLM` | off | 012 |
| `BUNDLE_SELECTOR_ENABLED` | on | 013 |
| `RETRIEVAL_EXECUTOR_CRITIC` | on | 015 |

Each downstream gate reads its flag inline and silently degrades when the flag is off. That is the correct local behaviour, but it hides the fact that several combinations of flags are **incoherent** — i.e. they leave the system in a state where one stage is asked to consume the output of a stage that was never produced.

The 100-point SOTA++ acceptance criteria require that such combinations be **rejected at startup**, not silently absorbed. A container boot with incoherent flags must fail fast.

## Decision

Introduce `src/config/feature-flag-coherence.ts` with:

1. `FeatureFlagSnapshot` — an immutable typed view of the four relevant env flags.
2. `snapshotFeatureFlagsFromEnv(env)` — pure parser honouring the same default semantics as the downstream readers (`CONSTRAINT_GRAPH_EMIT`, `BUNDLE_SELECTOR_ENABLED`, and `RETRIEVAL_EXECUTOR_CRITIC` default on; `CONSTRAINT_GRAPH_TOPOLOGY_LLM` defaults off).
3. `validateFeatureFlagCoherence(snapshot)` — pure validator that collects **all** rule violations before throwing `FlagCoherenceError`.
4. `validateFeatureFlagsAtStartup(env)` — cached wrapper called once per process from the composition root (`buildQueryPlanner`).

The composition root calls `validateFeatureFlagsAtStartup()` at the top of `buildQueryPlanner`, before any planner dependencies are constructed. On violation the function throws and the container boot aborts.

### Rules

| # | Rule | Rationale |
|---|---|---|
| 1 | `BUNDLE_SELECTOR_ENABLED=true` requires `CONSTRAINT_GRAPH_EMIT=true` | The selector assigns retrievals to graph nodes. With emission off there are no graphs, so the selector becomes a silent no-op — reaping all of the selector's planning cost but producing none of its benefit. |
| 2 | `CONSTRAINT_GRAPH_TOPOLOGY_LLM=true` requires `CONSTRAINT_GRAPH_EMIT=true` | The topology planner is invoked via an LLM call whose output is a graph topology. `ConstraintCompiler` discards that output when emission is off, so every query spends an LLM call on work that is immediately thrown away. |
| 3 | `RETRIEVAL_EXECUTOR_CRITIC=true` requires `CONSTRAINT_GRAPH_EMIT=true` | The critic's termination signal is `computeGraphCoverage`, which reads the constraint graph. Without a graph the computation raises on every critic-eligible query; fail at boot instead of on the first request. |
### Failure semantics

- `FlagCoherenceError` carries a readonly `violations: string[]` field with the full list so operators fix all mis-configurations in one pass.
- The validator is pure: no env reads, no logging, no process.exit.
- The container layer decides how to surface the failure. Today it lets the exception propagate out of `buildCoreContainerServices` — crashing the process before the HTTP server binds.

## Consequences

**Positive**
- Incoherent flag combinations can no longer reach production silently.
- New flags added in future waves have a single, centralised place to register cross-flag pre-conditions.
- Cached validation avoids re-parsing env on every builder invocation while still providing a test hook (`resetFeatureFlagCoherenceCacheForTests`) for focused coverage.

**Negative**
- Tests that previously set individual flags to study local behaviour must now ensure the combination is coherent. The default-on posture for the graph executor flags is deliberately chosen so that a plain default environment passes the validator without any change.

**Out of scope**
- The validator only checks **static** pre-conditions on env flags. Runtime coherence (e.g. graph emission disabled at request time via a per-query override) is still the responsibility of the individual downstream readers.

## References

- Wiring call-site: `src/config/container-core-builders.ts` → `buildQueryPlanner`
- Regression tests: `test/regression/feature-flag-coherence.regression.test.ts`
- Downstream inline readers:
  - `src/domain/query/service/constraint-graph-flags.ts` — `CONSTRAINT_GRAPH_EMIT`
  - `src/application/search/search-usecase-graph-executor.ts` — `BUNDLE_SELECTOR_ENABLED`, `RETRIEVAL_EXECUTOR_CRITIC`
  - `src/config/container-core-builders.ts` — `CONSTRAINT_GRAPH_TOPOLOGY_LLM`
