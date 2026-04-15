/**
 * ADR-018: Feature flag coherence validator.
 *
 * The SOTA++ train (ADRs 010..016) introduced five env feature flags that
 * gate interlocking stages of the retrieval pipeline. Certain combinations
 * are INCOHERENT — they leave the system in a state where downstream code
 * either silently no-ops or reaches for a dependency that was never
 * produced. These failures are hard to diagnose from logs alone, so the
 * composition root refuses to start the process on any such combination.
 *
 * Rules (see docs/adr/018-feature-flag-coherence.md for rationale):
 *
 *  1. `BUNDLE_SELECTOR_ENABLED=true` requires `CONSTRAINT_GRAPH_EMIT=true`.
 *     BundleSelector assigns retrievals to graph nodes; with emission off
 *     there are no graphs, so the selector is a silent no-op.
 *
 *  2. `CONSTRAINT_GRAPH_TOPOLOGY_LLM=true` requires
 *     `CONSTRAINT_GRAPH_EMIT=true`. The topology planner produces a
 *     graph topology that ConstraintCompiler discards when emission is
 *     off, wasting an LLM call per request.
 *
 *  3. `RETRIEVAL_EXECUTOR_CRITIC=true` requires `CONSTRAINT_GRAPH_EMIT=true`.
 *     The critic computes graph coverage as its termination signal; a
 *     missing graph would raise a runtime error on every critic-eligible
 *     query.
 *
 *  4. `GCE_PRIMARY=true` requires `GCE_SHADOW_EMIT=true`. Primary mode
 *     serves the 9-class grounded verifier to users; turning it on
 *     without ever having measured shadow parity violates ADR-016 §2.8.
 *
 * All rules are pre-conditions on invariant configuration, not runtime
 * state. The validator is a pure function and must not read process.env
 * directly; callers pass a snapshot.
 *
 * @module config/feature-flag-coherence
 */

/**
 * Immutable snapshot of the five SOTA-train feature flags, plus the
 * Axis-3 shadow/primary flags.
 */
export interface FeatureFlagSnapshot {
  readonly constraintGraphEmit: boolean;
  readonly constraintGraphTopologyLlm: boolean;
  readonly bundleSelectorEnabled: boolean;
  readonly retrievalExecutorCritic: boolean;
  readonly gceShadowEmit: boolean;
  readonly gcePrimary: boolean;
}

/**
 * Structured error thrown when a feature flag combination is incoherent.
 * Carries the full list of violations (not just the first) so operators
 * can fix all mis-configurations in one pass.
 */
export class FlagCoherenceError extends Error {
  public readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `Incoherent feature flag configuration:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'FlagCoherenceError';
    this.violations = violations;
  }
}

/**
 * Parse an env record into a {@link FeatureFlagSnapshot}.
 *
 * Semantics mirror the historical per-flag inline reads so that this
 * validator can never disagree with the downstream consumers:
 *  - `CONSTRAINT_GRAPH_EMIT` defaults to **on**. Only the literal string
 *    `'false'` disables it. This matches
 *    `isConstraintGraphEmitEnabled()` in constraint-graph-flags.ts.
 *  - Every other flag defaults to **off**. Only the literal string
 *    `'true'` enables it.
 */
export function snapshotFeatureFlagsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagSnapshot {
  return {
    constraintGraphEmit: env['CONSTRAINT_GRAPH_EMIT'] !== 'false',
    constraintGraphTopologyLlm: env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'] === 'true',
    bundleSelectorEnabled: env['BUNDLE_SELECTOR_ENABLED'] === 'true',
    retrievalExecutorCritic: env['RETRIEVAL_EXECUTOR_CRITIC'] === 'true',
    gceShadowEmit: env['GCE_SHADOW_EMIT'] === 'true',
    gcePrimary: env['GCE_PRIMARY'] === 'true',
  };
}

/**
 * Validate a feature flag snapshot.
 *
 * Collects ALL violations before throwing. Pure function — no env reads,
 * no logging. Callers decide how to surface the failure (the composition
 * root calls this at boot and lets the exception crash the process).
 *
 * @throws {FlagCoherenceError} when any rule fails.
 */
export function validateFeatureFlagCoherence(
  snapshot: FeatureFlagSnapshot,
): void {
  const violations: string[] = [];

  if (snapshot.bundleSelectorEnabled && !snapshot.constraintGraphEmit) {
    violations.push('BUNDLE_SELECTOR_ENABLED requires CONSTRAINT_GRAPH_EMIT');
  }

  if (snapshot.constraintGraphTopologyLlm && !snapshot.constraintGraphEmit) {
    violations.push(
      'CONSTRAINT_GRAPH_TOPOLOGY_LLM requires CONSTRAINT_GRAPH_EMIT',
    );
  }

  if (snapshot.retrievalExecutorCritic && !snapshot.constraintGraphEmit) {
    violations.push('RETRIEVAL_EXECUTOR_CRITIC requires CONSTRAINT_GRAPH_EMIT');
  }

  if (snapshot.gcePrimary && !snapshot.gceShadowEmit) {
    violations.push('GCE_PRIMARY requires GCE_SHADOW_EMIT');
  }

  if (violations.length > 0) {
    throw new FlagCoherenceError(violations);
  }
}

/**
 * Module-level cache for the boot-time validation result. The validator
 * is idempotent — repeated calls re-read process.env, so caching avoids
 * the (tiny) cost of redundant work and, more importantly, documents
 * that the answer is expected to be stable for the process lifetime.
 *
 * Reset via {@link resetFeatureFlagCoherenceCacheForTests} from tests
 * that need to observe a fresh validation under different env values.
 */
let cachedValidationEnvRef: NodeJS.ProcessEnv | undefined;

/**
 * Perform the boot-time validation against `process.env` (or an injected
 * env record for tests) and cache the result. Intended to be called once
 * per process from the composition root.
 *
 * Subsequent calls with the same env reference return without
 * re-validating. Call {@link resetFeatureFlagCoherenceCacheForTests} if
 * you need to observe a fresh validation pass under different env.
 */
export function validateFeatureFlagsAtStartup(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cachedValidationEnvRef === env) {
    return;
  }
  validateFeatureFlagCoherence(snapshotFeatureFlagsFromEnv(env));
  cachedValidationEnvRef = env;
}

/**
 * Test-only hook: clear the cached validation marker so the next call to
 * {@link validateFeatureFlagsAtStartup} re-runs the full validation.
 * Production code must not call this.
 */
export function resetFeatureFlagCoherenceCacheForTests(): void {
  cachedValidationEnvRef = undefined;
}
