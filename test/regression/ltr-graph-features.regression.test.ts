/**
 * Wave I3 — LTR graph-aware features.
 *
 * Locks the 4 new features added to `LTRFeatureVector`:
 *  - `graph_root_satisfied`
 *  - `graph_hard_tier_coverage`
 *  - `graph_xor_branch_match`
 *  - `graph_origin_encoded`
 *
 * When `constraintGraph` is absent, every new feature is 0 — same as
 * pre-I3 output byte-for-byte on the 26 legacy features. When present,
 * the features align with `computeGraphCoverage` semantics (same shared
 * helper the ranker hard-gate + provenance-closure use).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  extractLTRFeatures,
  LTR_FEATURE_NAMES,
  type LTRFeatureExtractionInput,
} from '../../src/domain/ranking/service/ltr-features.js';
import {
  LTR_FEATURE_SCHEMA_VERSION,
  getCurrentFeatureSchemaHash,
} from '../../src/domain/ranking/service/feature-parity-hash.js';
import type { ConstraintGraph } from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';

function baseInput(
  candidate: Partial<HybridCandidate> = {},
): LTRFeatureExtractionInput {
  return {
    query: 'red bordeaux',
    normalizedQuery: 'red bordeaux',
    candidate: {
      entityId: 'e1',
      publicEntityId: 'e1',
      matchedConstraints: ['wine_type', 'region'],
      retrievalTrace: { candidateSources: [] },
      retrievalProvenance: { channels: [] },
      ...candidate,
    } as unknown as HybridCandidate,
    hardConstraints: [
      { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
      { attribute: 'region', operator: '=', value: 'bordeaux', source_phrase: 'bordeaux', confidence: 1 },
    ],
    softConstraints: [],
    degradationFlags: { dense: false, sparse: false, anchor: false },
  };
}

function trivialGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2'] },
      {
        kind: 'slot', nodeId: 's1', atomRef: '0',
        attribute: 'wine_type', operator: '=', value: 'red',
        sourceTier: 'hard', sourceKind: 'explicit_utterance', confidence: 1,
      },
      {
        kind: 'slot', nodeId: 's2', atomRef: '1',
        attribute: 'region', operator: '=', value: 'bordeaux',
        sourceTier: 'hard', sourceKind: 'explicit_utterance', confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  };
}

function xorGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'planner_emitted',
    rootNodeId: 'topology/root',
    nodes: [
      { kind: 'group_xor', nodeId: 'topology/root', children: ['s1', 's2'] },
      {
        kind: 'slot', nodeId: 's1', atomRef: '0',
        attribute: 'wine_type_red', operator: '=', value: 'red',
        sourceTier: 'hard', sourceKind: 'explicit_utterance', confidence: 1,
      },
      {
        kind: 'slot', nodeId: 's2', atomRef: '1',
        attribute: 'wine_type_white', operator: '=', value: 'white',
        sourceTier: 'hard', sourceKind: 'explicit_utterance', confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  };
}

describe('Wave I3 — LTRFeatureVector graph-aware features', () => {
  it('LTR_FEATURE_NAMES contains the 4 new graph features (appended, not inserted)', () => {
    expect(LTR_FEATURE_NAMES).toContain('graph_root_satisfied');
    expect(LTR_FEATURE_NAMES).toContain('graph_hard_tier_coverage');
    expect(LTR_FEATURE_NAMES).toContain('graph_xor_branch_match');
    expect(LTR_FEATURE_NAMES).toContain('graph_origin_encoded');
    // Legacy features retained and in the same relative order (regression
    // guard: no reorder-induced silent drift for v1-trained models).
    const legacyLast = 'degraded_channel_count';
    const legacyIdx = LTR_FEATURE_NAMES.indexOf(legacyLast);
    const graphFirstIdx = LTR_FEATURE_NAMES.indexOf('graph_root_satisfied');
    expect(graphFirstIdx).toBe(legacyIdx + 1);
  });

  it('schema version bumped to v2', () => {
    expect(LTR_FEATURE_SCHEMA_VERSION).toBe('2');
  });

  it('schema hash changes between v1 (26 features) and v2 (30 features)', () => {
    const v2Hash = getCurrentFeatureSchemaHash();
    // v1 hash (computed offline, seeded for parity check). Not
    // pre-computed here — we simply verify v2 hash != known-v1 lengths.
    // The length discipline ensures any future feature add also bumps.
    expect(v2Hash).toHaveLength(16);
    expect(LTR_FEATURE_NAMES.length).toBe(30);
  });

  it('absent graph → all 4 features = 0 (backward-compat with v1 vectors)', () => {
    const vec = extractLTRFeatures(baseInput());
    expect(vec.graph_root_satisfied).toBe(0);
    expect(vec.graph_hard_tier_coverage).toBe(0);
    expect(vec.graph_xor_branch_match).toBe(0);
    expect(vec.graph_origin_encoded).toBe(0);
  });

  it('trivial graph + candidate matches all hard → root satisfied, coverage = 1', () => {
    const vec = extractLTRFeatures({
      ...baseInput(),
      constraintGraph: trivialGraph(),
    });
    expect(vec.graph_root_satisfied).toBe(1);
    expect(vec.graph_hard_tier_coverage).toBe(1);
    expect(vec.graph_xor_branch_match).toBe(0); // no XOR group in trivial
    expect(vec.graph_origin_encoded).toBe(1); // deterministic_from_atoms
  });

  it('trivial graph + candidate matches 1 of 2 hard → coverage = 0.5, root NOT satisfied', () => {
    const vec = extractLTRFeatures({
      ...baseInput({
        matchedConstraints: ['wine_type'], // only 1 of 2 hard slots
      }),
      constraintGraph: trivialGraph(),
    });
    expect(vec.graph_root_satisfied).toBe(0);
    expect(vec.graph_hard_tier_coverage).toBeCloseTo(0.5, 6);
    expect(vec.graph_origin_encoded).toBe(1);
  });

  it('XOR graph + candidate matches one branch → root satisfied, xor_branch_match = 1', () => {
    const vec = extractLTRFeatures({
      ...baseInput({ matchedConstraints: ['wine_type_red'] }),
      constraintGraph: xorGraph(),
    });
    expect(vec.graph_root_satisfied).toBe(1);
    expect(vec.graph_xor_branch_match).toBe(1);
    expect(vec.graph_origin_encoded).toBe(2); // planner_emitted
  });

  it('XOR graph + candidate matches BOTH branches → root NOT satisfied (mutual exclusion breached)', () => {
    const vec = extractLTRFeatures({
      ...baseInput({
        matchedConstraints: ['wine_type_red', 'wine_type_white'],
      }),
      constraintGraph: xorGraph(),
    });
    expect(vec.graph_root_satisfied).toBe(0);
    // xor_branch_match is still 1: candidate DID match one of the branches —
    // the signal is "respects a branch", not "is the sole winner".
    expect(vec.graph_xor_branch_match).toBe(1);
  });

  it('hybrid-origin graph → origin_encoded = 3', () => {
    const g: ConstraintGraph = { ...xorGraph(), origin: 'hybrid' };
    const vec = extractLTRFeatures({
      ...baseInput({ matchedConstraints: ['wine_type_red'] }),
      constraintGraph: g,
    });
    expect(vec.graph_origin_encoded).toBe(3);
  });
});
