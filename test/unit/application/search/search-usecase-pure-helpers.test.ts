import { describe, it, expect } from 'vitest';
import { buildDecisionSnapshotFromPlan } from '../../../../src/application/search/search-usecase-decision-snapshot.js';
import { buildSearchCounterfactuals } from '../../../../src/application/search/search-usecase-counterfactuals.js';
import {
  extractProducerBrowseSeed,
  extractRegionBrowseSeed,
} from '../../../../src/application/search/search-usecase-hybrid-candidates.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'unknown',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

describe('extractProducerBrowseSeed', () => {
  it('uses strongest anchor surface form', () => {
    const plan = minimalPlan({
      anchors: [
        {
          surfaceForm: 'weak',
          normalizedForm: 'weak',
          candidateEntityIds: [],
          confidence: 0.5,
        },
        {
          surfaceForm: 'Opus',
          normalizedForm: 'opus',
          candidateEntityIds: [],
          confidence: 0.95,
        },
      ],
    });
    expect(extractProducerBrowseSeed(plan)).toBe('Opus');
  });
});

describe('extractRegionBrowseSeed', () => {
  it('reads region from hard constraints', () => {
    const plan = minimalPlan({
      constraints: {
        hard: [
          {
            attribute: 'region',
            operator: '=',
            value: '  Burgundy  ',
            source_phrase: 'Burgundy',
            confidence: 0.9,
          },
        ],
        soft: [],
        inferred: [],
      },
    });
    expect(extractRegionBrowseSeed(plan)).toBe('Burgundy');
  });

  it('falls back to compacted normalized query', () => {
    const plan = minimalPlan({
      normalizedQuery: 'show wines from napa valley',
    });
    expect(extractRegionBrowseSeed(plan)).toContain('napa');
  });

  it('joins hierarchical path segments when ≥2 slashes and no region constraint', () => {
    const plan = minimalPlan({
      normalizedQuery: 'france / bordeaux / medoc',
    });
    expect(extractRegionBrowseSeed(plan)).toBe('france / bordeaux / medoc');
  });
});

describe('buildDecisionSnapshotFromPlan', () => {
  it('adds nondeterminism_notes when versions absent', () => {
    const plan = minimalPlan();
    const snap = buildDecisionSnapshotFromPlan(plan, undefined);
    expect(snap.nondeterminism_notes).toContain('not injected');
  });

  it('adds nondeterminism_notes when both maps empty', () => {
    const plan = minimalPlan();
    const snap = buildDecisionSnapshotFromPlan(plan, {
      modelVersions: {},
      indexVersions: {},
    });
    expect(snap.nondeterminism_notes).toContain('empty');
  });
});

describe('buildSearchCounterfactuals', () => {
  it('includes non-top resolver candidates', () => {
    const topId = createEntityId();
    const otherId = createEntityId();
    const resolverResult: EntityResolveResult = {
      status: 'resolved',
      candidates: [
        {
          entityId: topId,
          canonicalLabel: 'Top',
          calibratedScore: 0.9,
          rank: 1,
          evidenceRefs: [],
        },
        {
          entityId: otherId,
          canonicalLabel: 'Alt',
          calibratedScore: 0.5,
          rank: 2,
          evidenceRefs: [],
        },
      ],
      decisionTrace: {
        queryClass: 'unknown',
        top1CalibratedScore: 0.9,
        top2CalibratedScore: 0.5,
        calibratedGap: 0.4,
        decisionConfidenceC: 0.9,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: [],
      },
      topEntity: { entityId: topId, canonicalLabel: 'Top', calibratedScore: 0.9 },
      conformalSetSize: 1,
    };
    const cfs = buildSearchCounterfactuals(resolverResult, [], 5);
    expect(cfs.some((c) => c.entityId === otherId)).toBe(true);
  });
});
