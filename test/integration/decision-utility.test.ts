/**
 * Integration tests for EvalRunner + Decision Utility metrics.
 *
 * Uses a deterministic golden pipeline stub (returns gold labels + synthetic evidence)
 * so this file validates wiring and metric math without flaking on SearchUseCase routing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EvalRunner,
  type SearchPipelinePort,
  type SearchPipelineOutput,
  type ReleaseGates,
} from '../../src/domain/evaluation/service/eval-runner.js';
import type { EvalCase } from '../../src/domain/evaluation/model/eval-case.js';
import type { EntityId, EvidenceItem } from '../../src/domain/shared/types/index.js';
import type { DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import type { FunnelMetrics } from '../../src/domain/ranking/model/ranking-stage.js';
import { InMemoryGoldSetStore, InMemoryEvalResultStore } from './helpers/in-memory-adapters.js';
import {
  OPUS_ONE_ID,
  CHATEAU_MARGAUX_ID,
  ROMANEE_CONTI_ID,
  SASSICAIA_ID,
  PENFOLDS_GRANGE_ID,
  CLOUDY_BAY_ID,
  MOET_BRUT_ID,
  SAUTERNES_ID,
  BAROLO_GIACOMO_ID,
  MASI_AMARONE_ID,
} from './helpers/test-fixtures.js';

const STUB_EVIDENCE: readonly EvidenceItem[] = [
  {
    type: 'lexical_match',
    source: 'golden_eval_stub',
    contribution: '+0.55',
    strength: 'high',
    provenance: 'golden eval stub',
  },
];

const STUB_SNAPSHOT: DecisionSnapshot = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: 'golden-eval-stub',
  threshold_profile_id: 'default',
  planner_version: 'golden-eval-stub',
  feature_flags: {},
};

const STUB_FUNNEL_METRICS: FunnelMetrics = {
  coarsePrunePassRate: 0.8,
  rerankChangedTopK: false,
  meanFinalScore: 0.88,
  scoreGapRank1Rank2: 0.11,
  producerDiversity: 1,
};

/**
 * Returns exactly the gold label for each query so aggregate metrics are stable.
 */
class GoldenEvalPipelineAdapter implements SearchPipelinePort {
  constructor(private readonly cases: readonly EvalCase[]) {}

  async execute(query: string, _queryClass: EvalCase['queryClass']): Promise<SearchPipelineOutput> {
    const c = this.cases.find((x) => x.query === query);
    if (c === undefined) {
      throw new Error(`golden eval stub: missing case for query ${query}`);
    }

    const resolved = c.expectedStatus === 'resolved';
    return {
      predictedStatus: c.expectedStatus,
      ...(resolved && c.expectedEntityId !== undefined ? { predictedEntityId: c.expectedEntityId } : {}),
      decisionConfidence: 0.88,
      evidenceItems: resolved ? STUB_EVIDENCE : [],
      ...(resolved ? { funnelMetrics: STUB_FUNNEL_METRICS } : {}),
      latencyMs: 1,
      decisionSnapshot: STUB_SNAPSHOT,
    };
  }
}

function makeCase(
  id: string,
  query: string,
  queryClass: EvalCase['queryClass'],
  expectedStatus: EvalCase['expectedStatus'],
  expectedEntityId?: EntityId,
  sliceTags: string[] = [],
): EvalCase {
  return {
    caseId: id,
    query,
    queryClass,
    expectedStatus,
    ...(expectedEntityId !== undefined ? { expectedEntityId } : {}),
    labelTier: 'gold',
    annotatorAgreement: 0.9,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    sliceTags,
  };
}

const RELAXED_RELEASE_GATES: ReleaseGates = {
  minUtility: 0.0,
  maxWrongResolveRate: 1.0,
  maxECE: 1.0,
  maxEAURC: 1.0,
  maxAdmissionViolationRate: 1.0,
  minEvidenceSufficiency: 0.0,
  minEvidenceComprehensiveness: 0.0,
};

describe('Decision Utility — Eval Set Integration', () => {
  let goldSetStore: InMemoryGoldSetStore;
  let evalResultStore: InMemoryEvalResultStore;
  let evalRunner: EvalRunner;
  let evalCases: EvalCase[];

  beforeEach(async () => {
    evalCases = [
      makeCase('ec-01', 'Opus One 2018', 'short_entity', 'resolved', OPUS_ONE_ID, ['entity', 'english']),
      makeCase('ec-02', '오푸스원', 'short_entity', 'resolved', OPUS_ONE_ID, ['entity', 'korean']),
      makeCase('ec-03', 'Château Margaux 2015', 'short_entity', 'resolved', CHATEAU_MARGAUX_ID, ['entity', 'french']),
      makeCase('ec-04', 'Chateau Margaux', 'short_entity', 'resolved', CHATEAU_MARGAUX_ID, ['entity', 'english']),
      makeCase('ec-05', '클라우디베이', 'short_entity', 'resolved', CLOUDY_BAY_ID, ['entity', 'korean']),
      makeCase('ec-06', '풀바디 레드 와인', 'pure_constraint', 'resolved', undefined, ['hybrid', 'korean']),
      makeCase('ec-07', 'full body red wine', 'pure_constraint', 'resolved', undefined, ['hybrid', 'english']),
      makeCase('ec-08', '스파클링 와인', 'pure_constraint', 'resolved', MOET_BRUT_ID, ['hybrid', 'korean', 'sparkling']),
      makeCase('ec-09', '달달한 디저트 와인', 'semantic_preference', 'resolved', SAUTERNES_ID, ['hybrid', 'korean', 'sweet']),
      makeCase('ec-10', 'light red wine Burgundy', 'pure_constraint', 'resolved', ROMANEE_CONTI_ID, ['hybrid', 'english']),
      makeCase('ec-11', '오푸스원 같은 와인', 'anchored_similarity', 'resolved', undefined, ['mixed', 'korean']),
      makeCase('ec-12', 'Sassicaia similar style', 'anchored_similarity', 'resolved', undefined, ['mixed', 'english']),
      makeCase('ec-13', '클라우디베이 말고 다른 화이트', 'anchored_similarity', 'resolved', undefined, ['mixed', 'korean']),
      makeCase('ec-14', '마고', 'ambiguous_short_form', 'ambiguous', undefined, ['ambiguous', 'korean']),
      makeCase('ec-15', 'DRC', 'ambiguous_short_form', 'resolved', ROMANEE_CONTI_ID, ['entity', 'english', 'abbreviation']),
      makeCase('ec-16', 'Sassicaia 2018', 'short_entity', 'resolved', SASSICAIA_ID, ['entity', 'italian']),
      makeCase('ec-17', 'Penfolds Grange 2017', 'short_entity', 'resolved', PENFOLDS_GRANGE_ID, ['entity', 'australian']),
      makeCase('ec-18', 'Masi Amarone', 'short_entity', 'resolved', MASI_AMARONE_ID, ['entity', 'italian']),
      makeCase('ec-19', 'Barolo Monfortino', 'short_entity', 'resolved', BAROLO_GIACOMO_ID, ['entity', 'italian']),
      makeCase('ec-20', 'Moet Brut', 'short_entity', 'resolved', MOET_BRUT_ID, ['entity', 'champagne']),
    ];

    goldSetStore = new InMemoryGoldSetStore();
    evalResultStore = new InMemoryEvalResultStore();

    for (const ec of evalCases) {
      await goldSetStore.addCase(ec);
    }

    const pipeline = new GoldenEvalPipelineAdapter(evalCases);
    evalRunner = new EvalRunner(goldSetStore, evalResultStore, pipeline, RELAXED_RELEASE_GATES);
  });

  it('aggregate Decision Utility is computed and within valid range', async () => {
    const report = await evalRunner.run();

    expect(report.caseCount).toBe(20);
    expect(Number.isFinite(report.overallMetrics.decisionUtility)).toBe(true);
    expect(report.overallMetrics.decisionUtility).toBeGreaterThanOrEqual(-1.5);
    expect(report.overallMetrics.decisionUtility).toBeLessThanOrEqual(1.0);
  });

  it('wrongResolveRate is zero under golden stub (labels match gold)', async () => {
    const report = await evalRunner.run();

    expect(report.overallMetrics.wrongResolveRate).toBe(0);
  });

  it('evidenceCompletenessRate is 1 — every resolved result has evidence', async () => {
    const report = await evalRunner.run();

    expect(report.overallMetrics.evidenceCompletenessRate).toBe(1);

    const stored = evalResultStore.getAll();
    const resolvedResults = stored.filter((r) => r.predictedStatus === 'resolved');
    for (const r of resolvedResults) {
      expect(r.evidenceItems.length).toBeGreaterThan(0);
    }
  });

  it('safeAbstainRate reflects the ambiguous gold case', async () => {
    const report = await evalRunner.run();

    expect(report.overallMetrics.safeAbstainRate).toBeGreaterThan(0);
    expect(report.overallMetrics.safeAbstainRate).toBeLessThanOrEqual(1);
  });

  it('eval run persists results to the eval result store', async () => {
    await evalRunner.run();

    const stored = evalResultStore.getAll();
    expect(stored.length).toBe(20);
    for (const result of stored) {
      expect(result.caseId).toBeTruthy();
      expect(result.evidenceItems).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('propagates ranking funnel metrics into stored eval results when available', async () => {
    await evalRunner.run();

    const stored = evalResultStore.getAll();
    const resolvedWithEvidence = stored.find((result) => result.predictedStatus === 'resolved');
    expect(resolvedWithEvidence?.funnelMetrics).toEqual(
      expect.objectContaining({
        coarsePrunePassRate: 0.8,
        meanFinalScore: 0.88,
      }),
    );

    const ambiguous = stored.find((result) => result.predictedStatus === 'ambiguous');
    expect(ambiguous?.funnelMetrics).toBeUndefined();
  });

  it('eval report contains per-slice metrics', async () => {
    const report = await evalRunner.run();

    expect(report.sliceMetrics).toBeDefined();
    expect(Array.isArray(report.sliceMetrics)).toBe(true);
  });

  it('release gate check runs without error', async () => {
    const report = await evalRunner.run();

    expect(report.releaseGateResult).toBeDefined();
    expect(typeof report.releaseGateResult.passed).toBe('boolean');
    expect(report.releaseGateResult.gates.length).toBeGreaterThan(0);
  });
});
