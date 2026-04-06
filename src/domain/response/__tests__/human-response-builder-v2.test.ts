import { describe, it, expect } from 'vitest';
import {
  buildHumanResponseV2,
  type HumanResponseBuildParamsV2,
} from '../service/human-response-builder-v2.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';
import type { FunnelMetrics } from '../../ranking/model/ranking-stage.js';
import { createEntityId } from '../../shared/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<RankedResult> & Pick<RankedResult, 'entityId' | 'canonicalLabel' | 'rank' | 'finalScore'>): RankedResult {
  return {
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [],
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.8,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 1.0,
      uncertaintyPenalty: 0,
    },
    ...overrides,
  };
}

function makeFunnelMetrics(): FunnelMetrics {
  return {
    coarsePrunePassRate: 0.85,
    rerankChangedTopK: true,
    meanFinalScore: 0.72,
    scoreGapRank1Rank2: 0.15,
    producerDiversity: 3,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildHumanResponseV2', () => {
  describe('envelope fields', () => {
    it('sets version = "2" and responseType = "human"', () => {
      const result = buildHumanResponseV2({
        queryId: 'q-001',
        results: [],
        totalCandidates: 0,
      });

      expect(result.version).toBe('2');
      expect(result.responseType).toBe('human');
    });

    it('propagates queryId and totalCandidates', () => {
      const result = buildHumanResponseV2({
        queryId: 'q-999',
        results: [],
        totalCandidates: 42,
      });

      expect(result.queryId).toBe('q-999');
      expect(result.totalCandidates).toBe(42);
    });
  });

  describe('confidence normalisation', () => {
    it('single result → confidence = 1.0', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-single',
        results: [
          makeResult({
            entityId: createEntityId('wine-1'),
            canonicalLabel: 'Opus One 2018',
            rank: 1,
            finalScore: 0.7,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]?.confidence).toBe(1.0);
    });

    it('multiple results: rank-1 = 1.0, last = 0.0', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-multi',
        results: [
          makeResult({
            entityId: createEntityId('wine-1'),
            canonicalLabel: 'Opus One 2018',
            rank: 1,
            finalScore: 0.9,
          }),
          makeResult({
            entityId: createEntityId('wine-2'),
            canonicalLabel: 'Pétrus 2015',
            rank: 2,
            finalScore: 0.6,
          }),
          makeResult({
            entityId: createEntityId('wine-3'),
            canonicalLabel: 'Screaming Eagle 2017',
            rank: 3,
            finalScore: 0.3,
          }),
        ],
        totalCandidates: 3,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results).toHaveLength(3);

      const rank1 = response.results[0];
      const rank3 = response.results[2];

      expect(rank1?.confidence).toBe(1.0);
      expect(rank3?.confidence).toBe(0.0);
    });

    it('multiple results: intermediate confidence is linearly normalised', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-linear',
        results: [
          makeResult({
            entityId: createEntityId('wine-a'),
            canonicalLabel: 'Wine A',
            rank: 1,
            finalScore: 1.0,
          }),
          makeResult({
            entityId: createEntityId('wine-b'),
            canonicalLabel: 'Wine B',
            rank: 2,
            finalScore: 0.5,
          }),
          makeResult({
            entityId: createEntityId('wine-c'),
            canonicalLabel: 'Wine C',
            rank: 3,
            finalScore: 0.0,
          }),
        ],
        totalCandidates: 3,
      };

      const response = buildHumanResponseV2(params);
      // (0.5 - 0.0) / (1.0 - 0.0) = 0.5
      expect(response.results[1]?.confidence).toBeCloseTo(0.5);
    });

    it('all equal scores → all confidence = 1.0', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-tie',
        results: [
          makeResult({ entityId: createEntityId('w1'), canonicalLabel: 'W1', rank: 1, finalScore: 0.5 }),
          makeResult({ entityId: createEntityId('w2'), canonicalLabel: 'W2', rank: 2, finalScore: 0.5 }),
        ],
        totalCandidates: 2,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.confidence).toBe(1.0);
      expect(response.results[1]?.confidence).toBe(1.0);
    });
  });

  describe('drinkingWindow field', () => {
    it('omits drinkingWindow when both start and end are undefined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-nodw',
        results: [
          makeResult({
            entityId: createEntityId('wine-no-dw'),
            canonicalLabel: 'Some Wine',
            rank: 1,
            finalScore: 0.8,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]).not.toHaveProperty('drinkingWindow');
    });

    it('includes drinkingWindow when start is defined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-dw-start',
        results: [
          makeResult({
            entityId: createEntityId('wine-dw'),
            canonicalLabel: 'Aged Burgundy',
            rank: 1,
            finalScore: 0.8,
            drinkingWindowStart: 2024,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.drinkingWindow).toEqual({ start: 2024 });
    });

    it('includes drinkingWindow with both start and end when defined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-dw-both',
        results: [
          makeResult({
            entityId: createEntityId('wine-full-dw'),
            canonicalLabel: 'Bordeaux 2015',
            rank: 1,
            finalScore: 0.9,
            drinkingWindowStart: 2023,
            drinkingWindowEnd: 2035,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.drinkingWindow).toEqual({ start: 2023, end: 2035 });
    });

    it('includes drinkingWindow when only end is defined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-dw-end-only',
        results: [
          makeResult({
            entityId: createEntityId('wine-end-dw'),
            canonicalLabel: 'Early Drinker',
            rank: 1,
            finalScore: 0.7,
            drinkingWindowEnd: 2028,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.drinkingWindow).toEqual({ end: 2028 });
    });
  });

  describe('evidenceSummary', () => {
    it('returns human-readable text, not raw JSON', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-ev',
        results: [
          makeResult({
            entityId: createEntityId('wine-ev'),
            canonicalLabel: 'Burgundy Rouge',
            rank: 1,
            finalScore: 0.8,
            evidenceItems: [
              {
                type: 'region_match',
                source: 'vespa_retrieval',
                contribution: '+0.40',
                strength: 'high',
                provenance: 'Burgundy',
                metadata: { value: 'Burgundy' },
              },
              {
                type: 'grape_match',
                source: 'vespa_retrieval',
                contribution: '+0.30',
                strength: 'high',
                provenance: 'Pinot Noir',
                metadata: { value: 'Pinot Noir' },
              },
              {
                type: 'vintage_match',
                source: 'vespa_retrieval',
                contribution: '+0.20',
                strength: 'medium',
                provenance: '2018',
                metadata: { value: '2018' },
              },
            ],
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const summary = response.results[0]?.evidenceSummary ?? '';

      // Must be human-readable
      expect(summary).not.toContain('{');
      expect(summary).not.toContain('"type"');
      expect(summary).not.toContain('"source"');

      // Must contain signal labels and values
      expect(summary).toContain('Burgundy');
      expect(summary).toContain('Pinot Noir');
      expect(summary).toContain('2018');
    });

    it('includes at most top-3 evidence signals', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-top3',
        results: [
          makeResult({
            entityId: createEntityId('wine-top3'),
            canonicalLabel: 'Many Signals',
            rank: 1,
            finalScore: 0.8,
            evidenceItems: [
              { type: 'sig_a', source: 's', contribution: '+0.50', strength: 'high', provenance: 'Signal A' },
              { type: 'sig_b', source: 's', contribution: '+0.40', strength: 'high', provenance: 'Signal B' },
              { type: 'sig_c', source: 's', contribution: '+0.30', strength: 'medium', provenance: 'Signal C' },
              { type: 'sig_d', source: 's', contribution: '+0.20', strength: 'medium', provenance: 'Signal D' },
              { type: 'sig_e', source: 's', contribution: '+0.10', strength: 'low', provenance: 'Signal E' },
            ],
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const summary = response.results[0]?.evidenceSummary ?? '';

      // Top 3 by contribution weight should appear
      expect(summary).toContain('Signal A');
      expect(summary).toContain('Signal B');
      expect(summary).toContain('Signal C');

      // 4th and 5th should NOT appear
      expect(summary).not.toContain('Signal D');
      expect(summary).not.toContain('Signal E');
    });

    it('handles empty evidenceItems gracefully', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-noev',
        results: [
          makeResult({
            entityId: createEntityId('wine-noev'),
            canonicalLabel: 'No Evidence Wine',
            rank: 1,
            finalScore: 0.5,
            evidenceItems: [],
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const summary = response.results[0]?.evidenceSummary ?? '';
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain('{');
    });
  });

  describe('funnelMetrics', () => {
    it('propagates funnelMetrics when provided', () => {
      const metrics = makeFunnelMetrics();
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-fm',
        results: [],
        totalCandidates: 5,
        funnelMetrics: metrics,
      };

      const response = buildHumanResponseV2(params);
      expect(response.funnelMetrics).toEqual(metrics);
    });

    it('omits funnelMetrics when not provided', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-nofm',
        results: [],
        totalCandidates: 0,
      };

      const response = buildHumanResponseV2(params);
      expect(response).not.toHaveProperty('funnelMetrics');
    });
  });

  describe('result item fields', () => {
    it('maps entityId, canonicalLabel, rank correctly', () => {
      const eid = createEntityId('wine-map');
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-map',
        results: [
          makeResult({
            entityId: eid,
            canonicalLabel: 'Test Wine 2020',
            rank: 1,
            finalScore: 0.9,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const item = response.results[0];
      expect(item?.entityId).toBe(eid);
      expect(item?.canonicalLabel).toBe('Test Wine 2020');
      expect(item?.rank).toBe(1);
    });

    it('prefers vintageYear over vintage', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-vy',
        results: [
          makeResult({
            entityId: createEntityId('wine-vy'),
            canonicalLabel: 'Vintage Wine',
            rank: 1,
            finalScore: 0.8,
            vintageYear: 2018,
            vintage: 2015,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.vintage).toBe(2018);
    });

    it('falls back to vintage when vintageYear is absent', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-vfb',
        results: [
          makeResult({
            entityId: createEntityId('wine-vfb'),
            canonicalLabel: 'Legacy Wine',
            rank: 1,
            finalScore: 0.8,
            vintage: 2015,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.vintage).toBe(2015);
    });

    it('omits producer, region, vintage, grapePrimary when undefined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-omit',
        results: [
          makeResult({
            entityId: createEntityId('wine-omit'),
            canonicalLabel: 'Minimal Wine',
            rank: 1,
            finalScore: 0.6,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const item = response.results[0];
      expect(item).not.toHaveProperty('producer');
      expect(item).not.toHaveProperty('region');
      expect(item).not.toHaveProperty('vintage');
      expect(item).not.toHaveProperty('grapePrimary');
    });

    it('includes producer, region, grapePrimary when defined', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-attrs',
        results: [
          makeResult({
            entityId: createEntityId('wine-attrs'),
            canonicalLabel: 'Full Attrs Wine',
            rank: 1,
            finalScore: 0.9,
            producer: 'Domaine de la Romanée-Conti',
            region: 'Burgundy',
            grapePrimary: 'Pinot Noir',
            vintageYear: 2019,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      const item = response.results[0];
      expect(item?.producer).toBe('Domaine de la Romanée-Conti');
      expect(item?.region).toBe('Burgundy');
      expect(item?.grapePrimary).toBe('Pinot Noir');
      expect(item?.vintage).toBe(2019);
    });

    it('each result item has version = "2" and responseType = "human"', () => {
      const params: HumanResponseBuildParamsV2 = {
        queryId: 'q-item-meta',
        results: [
          makeResult({
            entityId: createEntityId('wine-im'),
            canonicalLabel: 'Meta Wine',
            rank: 1,
            finalScore: 0.7,
          }),
        ],
        totalCandidates: 1,
      };

      const response = buildHumanResponseV2(params);
      expect(response.results[0]?.version).toBe('2');
      expect(response.results[0]?.responseType).toBe('human');
    });
  });
});
