/**
 * ADR-018 Wave F3: feature flag coherence validator.
 *
 * Guards the four cross-flag pre-conditions that the 7-PR SOTA train
 * (ADRs 010..016) introduced. Any incoherent combination MUST throw at
 * startup — see docs/adr/018-feature-flag-coherence.md for the rule set.
 *
 * Append-only regression coverage: do not delete this file.
 */
import { describe, expect, it } from 'vitest';

import {
  FlagCoherenceError,
  snapshotFeatureFlagsFromEnv,
  validateFeatureFlagCoherence,
  type FeatureFlagSnapshot,
} from '../../src/config/feature-flag-coherence.js';

/** Base: all flags at their defaults (emit + selector + critic on). */
const defaultSnapshot: FeatureFlagSnapshot = {
  constraintGraphEmit: true,
  constraintGraphTopologyLlm: false,
  bundleSelectorEnabled: true,
  retrievalExecutorCritic: true,
  gceShadowEmit: false,
  gcePrimary: false,
};

function withOverrides(
  overrides: Partial<FeatureFlagSnapshot>,
): FeatureFlagSnapshot {
  return { ...defaultSnapshot, ...overrides };
}

describe('ADR-018 feature flag coherence — happy paths', () => {
  it('default snapshot passes (emit, selector, critic on; everything else off)', () => {
    expect(() => validateFeatureFlagCoherence(defaultSnapshot)).not.toThrow();
  });

  it('all-off snapshot passes', () => {
    const allOff: FeatureFlagSnapshot = {
      constraintGraphEmit: false,
      constraintGraphTopologyLlm: false,
      bundleSelectorEnabled: false,
      retrievalExecutorCritic: false,
      gceShadowEmit: false,
      gcePrimary: false,
    };
    expect(() => validateFeatureFlagCoherence(allOff)).not.toThrow();
  });

  it('all-on snapshot passes', () => {
    const allOn: FeatureFlagSnapshot = {
      constraintGraphEmit: true,
      constraintGraphTopologyLlm: true,
      bundleSelectorEnabled: true,
      retrievalExecutorCritic: true,
      gceShadowEmit: true,
      gcePrimary: true,
    };
    expect(() => validateFeatureFlagCoherence(allOn)).not.toThrow();
  });
});

describe('ADR-018 feature flag coherence — rule violations', () => {
  it('rule 1: BUNDLE_SELECTOR_ENABLED without CONSTRAINT_GRAPH_EMIT throws', () => {
    const snapshot = withOverrides({
      constraintGraphEmit: false,
      bundleSelectorEnabled: true,
      retrievalExecutorCritic: false,
    });
    expect.assertions(2);
    try {
      validateFeatureFlagCoherence(snapshot);
    } catch (err) {
      expect(err).toBeInstanceOf(FlagCoherenceError);
      expect((err as FlagCoherenceError).violations).toEqual([
        'BUNDLE_SELECTOR_ENABLED requires CONSTRAINT_GRAPH_EMIT',
      ]);
    }
  });

  it('rule 2: CONSTRAINT_GRAPH_TOPOLOGY_LLM without CONSTRAINT_GRAPH_EMIT throws', () => {
    const snapshot = withOverrides({
      constraintGraphEmit: false,
      constraintGraphTopologyLlm: true,
      bundleSelectorEnabled: false,
      retrievalExecutorCritic: false,
    });
    expect.assertions(2);
    try {
      validateFeatureFlagCoherence(snapshot);
    } catch (err) {
      expect(err).toBeInstanceOf(FlagCoherenceError);
      expect((err as FlagCoherenceError).violations).toEqual([
        'CONSTRAINT_GRAPH_TOPOLOGY_LLM requires CONSTRAINT_GRAPH_EMIT',
      ]);
    }
  });

  it('rule 3: RETRIEVAL_EXECUTOR_CRITIC without CONSTRAINT_GRAPH_EMIT throws', () => {
    const snapshot = withOverrides({
      constraintGraphEmit: false,
      bundleSelectorEnabled: false,
      retrievalExecutorCritic: true,
    });
    expect.assertions(2);
    try {
      validateFeatureFlagCoherence(snapshot);
    } catch (err) {
      expect(err).toBeInstanceOf(FlagCoherenceError);
      expect((err as FlagCoherenceError).violations).toEqual([
        'RETRIEVAL_EXECUTOR_CRITIC requires CONSTRAINT_GRAPH_EMIT',
      ]);
    }
  });

  it('rule 4: GCE_PRIMARY without GCE_SHADOW_EMIT throws', () => {
    const snapshot = withOverrides({
      gcePrimary: true,
      gceShadowEmit: false,
    });
    expect.assertions(2);
    try {
      validateFeatureFlagCoherence(snapshot);
    } catch (err) {
      expect(err).toBeInstanceOf(FlagCoherenceError);
      expect((err as FlagCoherenceError).violations).toEqual([
        'GCE_PRIMARY requires GCE_SHADOW_EMIT',
      ]);
    }
  });

  it('collects ALL violations before throwing (3 incoherent combos)', () => {
    const snapshot: FeatureFlagSnapshot = {
      constraintGraphEmit: false,
      constraintGraphTopologyLlm: true,
      bundleSelectorEnabled: true,
      retrievalExecutorCritic: true,
      gceShadowEmit: false,
      gcePrimary: false,
    };
    expect.assertions(3);
    try {
      validateFeatureFlagCoherence(snapshot);
    } catch (err) {
      expect(err).toBeInstanceOf(FlagCoherenceError);
      const violations = (err as FlagCoherenceError).violations;
      expect(violations).toHaveLength(3);
      // Order is stable: rule 1, rule 2, rule 3.
      expect(violations).toEqual([
        'BUNDLE_SELECTOR_ENABLED requires CONSTRAINT_GRAPH_EMIT',
        'CONSTRAINT_GRAPH_TOPOLOGY_LLM requires CONSTRAINT_GRAPH_EMIT',
        'RETRIEVAL_EXECUTOR_CRITIC requires CONSTRAINT_GRAPH_EMIT',
      ]);
    }
  });
});

describe('ADR-018 snapshotFeatureFlagsFromEnv — env parsing', () => {
  it('empty env: emit, selector, and critic default on; everything else defaults off', () => {
    const snapshot = snapshotFeatureFlagsFromEnv({});
    expect(snapshot).toEqual<FeatureFlagSnapshot>({
      constraintGraphEmit: true,
      constraintGraphTopologyLlm: false,
      bundleSelectorEnabled: true,
      retrievalExecutorCritic: true,
      gceShadowEmit: false,
      gcePrimary: false,
    });
  });

  it('literal "false" disables CONSTRAINT_GRAPH_EMIT; anything else keeps it on', () => {
    expect(
      snapshotFeatureFlagsFromEnv({ CONSTRAINT_GRAPH_EMIT: 'false' })
        .constraintGraphEmit,
    ).toBe(false);
    // Non-'false' values (typo, uppercase, garbage) keep the default ON.
    expect(
      snapshotFeatureFlagsFromEnv({ CONSTRAINT_GRAPH_EMIT: 'FALSE' })
        .constraintGraphEmit,
    ).toBe(true);
    expect(
      snapshotFeatureFlagsFromEnv({ CONSTRAINT_GRAPH_EMIT: '0' })
        .constraintGraphEmit,
    ).toBe(true);
  });

  it('only literal "false" disables the default-on flags, and only literal "true" enables the opt-in flags', () => {
    const offEnv: NodeJS.ProcessEnv = {
      BUNDLE_SELECTOR_ENABLED: 'false',
      RETRIEVAL_EXECUTOR_CRITIC: 'false',
    };
    const offSnapshot = snapshotFeatureFlagsFromEnv(offEnv);
    expect(offSnapshot.bundleSelectorEnabled).toBe(false);
    expect(offSnapshot.retrievalExecutorCritic).toBe(false);

    const onEnv: NodeJS.ProcessEnv = {
      CONSTRAINT_GRAPH_TOPOLOGY_LLM: 'true',
      BUNDLE_SELECTOR_ENABLED: 'true',
      RETRIEVAL_EXECUTOR_CRITIC: 'true',
      GCE_SHADOW_EMIT: 'true',
      GCE_PRIMARY: 'true',
    };
    const snapshot = snapshotFeatureFlagsFromEnv(onEnv);
    expect(snapshot.constraintGraphTopologyLlm).toBe(true);
    expect(snapshot.bundleSelectorEnabled).toBe(true);
    expect(snapshot.retrievalExecutorCritic).toBe(true);
    expect(snapshot.gceShadowEmit).toBe(true);
    expect(snapshot.gcePrimary).toBe(true);

    // Default-on flags ignore wrong-case truthy strings unless they are the
    // literal disabling token `'false'`. Opt-in flags still require the exact
    // literal `'true'`.
    const wrongCaseSnapshot = snapshotFeatureFlagsFromEnv({
      BUNDLE_SELECTOR_ENABLED: 'TRUE',
      GCE_PRIMARY: '1',
    });
    expect(wrongCaseSnapshot.bundleSelectorEnabled).toBe(true);
    expect(wrongCaseSnapshot.gcePrimary).toBe(false);
  });
});
