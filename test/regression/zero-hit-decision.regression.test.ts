/**
 * Regression: zero-hit-detector + DecisionEngine corpus-gap routing
 * (Wave 1 Cluster F).
 *
 * Before this regression, an empty candidate pool for a query with a
 * high-confidence anchor (e.g. "Sassicaia" — entity not in the indexed
 * corpus) routed through the numeric gate's low-confidence fallback to
 * `decisionStatus='ambiguous', nextAction='clarify'`. Clarification cannot
 * recover this — the user did not under-specify, the entity simply does
 * not exist in our catalogue.
 *
 * This regression pins:
 *   1. {@link classifyEmptyCandidatePool}:
 *        - empty candidates + ≥1 anchor at confidence ≥ floor → `corpus_gap`
 *        - empty candidates + no anchors → `low_confidence`
 *        - non-empty candidates → `normal`
 *   2. DecisionEngine: corpus_gap input → `nextAction='admit_to_user'`
 *      with `failureReason='NO_CORPUS_MATCH'` and
 *      `rulesApplied` containing `'CORPUS_GAP_DETECTED'`. NOT clarify.
 *   3. Empty candidates without anchors still flow through the existing
 *      low-confidence fallback (unchanged path).
 */

import { describe, expect, it } from 'vitest';
import { DecisionEngine } from '../../src/domain/decision/service/decision-engine.js';
import {
  classifyEmptyCandidatePool,
  CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR,
} from '../../src/domain/decision/service/zero-hit-detector.js';
import type { DecisionInput } from '../../src/domain/decision/model/decision-input.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { ThresholdStore } from '../../src/domain/query/port/threshold-store.port.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../src/domain/query/model/threshold-profile.js';
import { createCanonicalEntityId, createEntityId } from '../../src/domain/shared/types/index.js';

const TEST_SNAPSHOT = {
  snapshot_id: 'test-snapshot',
  model_versions: { embedding: 'test-v1' },
  index_versions: { wine_content: 'wine_content_v1' },
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'heuristic-v1.0',
  planner_version: '1.0.0',
  feature_flags: {},
} as const;

const TEST_THRESHOLD_STORE: ThresholdStore = {
  getProfile: async () => DEFAULT_THRESHOLD_PROFILE,
};

function makeAnchor(confidence: number): AnchorCandidate {
  return {
    surfaceForm: 'Sassicaia',
    normalizedForm: 'sassicaia',
    candidateEntityIds: [createCanonicalEntityId('e:sassicaia')],
    confidence,
    source: 'alias',
  };
}

function makeQueryPlan(anchors: readonly AnchorCandidate[]): QueryPlanV1 {
  return {
    rawQuery: 'Sassicaia',
    normalizedQuery: 'sassicaia',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors,
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.9,
      constraintConfidence: 0.8,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'heuristic-v1.0',
  } as unknown as QueryPlanV1;
}

function makeEmptyResolveResult(): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: undefined,
      top2CalibratedScore: undefined,
      calibratedGap: undefined,
      decisionConfidenceC: 0,
      calibrationTrusted: true,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.03 },
      outcomeReasonCodes: ['EMPTY_POOL'],
    },
    conformalSetSize: 0,
  } as unknown as EntityResolveResult;
}

function makeNonEmptyResolveResult(C: number): EntityResolveResult {
  const entityId = createEntityId('e:x');
  return {
    status: 'resolved',
    topEntity: { entityId, canonicalLabel: 'X', calibratedScore: C },
    candidates: [
      { entityId, canonicalLabel: 'X', calibratedScore: C, rank: 1, evidenceRefs: ['alias:x'] },
    ],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: undefined,
      calibratedGap: undefined,
      decisionConfidenceC: C,
      calibrationTrusted: true,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.03 },
      outcomeReasonCodes: ['HYBRID_ROUTE'],
    },
    conformalSetSize: 1,
  } as unknown as EntityResolveResult;
}

function makeInput(opts: {
  anchors: readonly AnchorCandidate[];
  resolveResult: EntityResolveResult;
}): DecisionInput {
  const queryPlan = makeQueryPlan(opts.anchors);
  return {
    queryPlan,
    resolveResult: opts.resolveResult,
    identityResolveResult: opts.resolveResult,
    effectiveRoute: queryPlan.route,
    effectiveRetrievalMode: queryPlan.retrievalMode,
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.9,
      constraintConfidence: 0.8,
    },
    provenanceContract: {
      policy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
      observed: {
        identityEvidenceSatisfied: false,
        constraintEvidenceSatisfied: true,
        anchorEvidenceSatisfied: false,
        topEntityPresent: opts.resolveResult.candidates.length > 0,
        rankedTopResultPresent: opts.resolveResult.candidates.length > 0,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: [],
    },
    conformalSetSize: opts.resolveResult.candidates.length,
  } as unknown as DecisionInput;
}

describe('classifyEmptyCandidatePool — Wave 1 Cluster F', () => {
  it('returns `corpus_gap` when candidates=0 AND ≥1 anchor at or above the confidence floor', () => {
    const classification = classifyEmptyCandidatePool({
      candidateCount: 0,
      anchors: [makeAnchor(CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR)],
    });
    expect(classification).toBe('corpus_gap');
  });

  it('returns `corpus_gap` when candidates=0 AND a HIGHER-than-floor anchor confidence', () => {
    const classification = classifyEmptyCandidatePool({
      candidateCount: 0,
      anchors: [makeAnchor(0.99)],
    });
    expect(classification).toBe('corpus_gap');
  });

  it('returns `low_confidence` when candidates=0 AND no anchors', () => {
    const classification = classifyEmptyCandidatePool({
      candidateCount: 0,
      anchors: [],
    });
    expect(classification).toBe('low_confidence');
  });

  it('returns `low_confidence` when candidates=0 AND only below-floor anchors', () => {
    // Below the deterministic tier-1 / tier-2 confidence floor, the anchor
    // is not a high-confidence identity claim — treat as low_confidence.
    const classification = classifyEmptyCandidatePool({
      candidateCount: 0,
      anchors: [makeAnchor(CORPUS_GAP_ANCHOR_CONFIDENCE_FLOOR - 0.01)],
    });
    expect(classification).toBe('low_confidence');
  });

  it('returns `normal` when candidates > 0 (regardless of anchor confidence)', () => {
    const classification = classifyEmptyCandidatePool({
      candidateCount: 5,
      anchors: [makeAnchor(0.99)],
    });
    expect(classification).toBe('normal');
  });

  it('ignores NaN/Infinity anchor confidence (treats as below floor)', () => {
    // Number.isFinite guard prevents NaN/Infinity from accidentally
    // satisfying the >= comparison via JS coercion.
    const classification = classifyEmptyCandidatePool({
      candidateCount: 0,
      anchors: [
        { ...makeAnchor(0.99), confidence: Number.NaN },
        { ...makeAnchor(0.99), confidence: Number.POSITIVE_INFINITY },
      ],
    });
    expect(classification).toBe('low_confidence');
  });
});

describe('DecisionEngine — corpus_gap routing (Wave 1 Cluster F)', () => {
  const engine = new DecisionEngine(TEST_THRESHOLD_STORE);

  it('routes corpus_gap to nextAction=admit_to_user with failureReason=NO_CORPUS_MATCH (NOT clarify)', async () => {
    const input = makeInput({
      anchors: [makeAnchor(0.95)],
      resolveResult: makeEmptyResolveResult(),
    });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.nextAction).toBe('admit_to_user');
    expect(output.nextAction).not.toBe('clarify');
    expect(output.failureReason).toBe('NO_CORPUS_MATCH');
    expect(output.decisionTrace.rulesApplied).toContain('CORPUS_GAP_DETECTED');
    expect(output.decisionStatus).toBe('failed');
  });

  it('low_confidence (no anchors) falls through to existing numeric-gate path (unchanged)', async () => {
    const input = makeInput({
      anchors: [],
      resolveResult: makeEmptyResolveResult(),
    });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    // No CORPUS_GAP_DETECTED rule fires; nextAction is the existing
    // low-confidence fallback (clarify / fail / hybrid_search depending
    // on policy.fallbackMode). With fallbackMode='clarify' AND C=0, the
    // numeric gate's low-confidence path emits ambiguous + clarify.
    expect(output.decisionTrace.rulesApplied).not.toContain('CORPUS_GAP_DETECTED');
    expect(output.nextAction).not.toBe('admit_to_user');
  });

  it('non-empty candidate pool does NOT trigger the corpus-gap path even when an anchor is present', async () => {
    const input = makeInput({
      anchors: [makeAnchor(0.95)],
      resolveResult: makeNonEmptyResolveResult(0.6),
    });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.decisionTrace.rulesApplied).not.toContain('CORPUS_GAP_DETECTED');
    expect(output.nextAction).not.toBe('admit_to_user');
  });
});
