/**
 * ADR-009 Phase 0: `buildEvidenceRecordsFromFrames` replaces the regex-based
 * `parseObservations` path. Locks the field projection so the deterministic
 * claim verifier keeps seeing the same column names it expects today.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { buildEvidenceRecordsFromFrames } from '../../src/domain/evaluation/service/build-evidence-records-from-frames.js';
import { verifyDeterministic } from '../../src/domain/evaluation/service/claim-verifier-deterministic.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type {
  ToolCallEvidenceFrame,
} from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import type { ExtractedClaim } from '../../src/domain/evaluation/model/claim.js';
import type { ResultItem } from '../../src/domain/response/model/result-item.js';

function makeFrame(overrides: Partial<ToolCallEvidenceFrame> = {}): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId: 'tc-1',
    toolName: 'search_wines',
    invokedAt: '2026-04-15T00:00:00Z',
    requestId: 'req-1',
    request: { toolName: 'search_wines', input: {} },
    structuredOutput: { kind: 'no_op', reason: 'stub' },
    observationSnapshot: '',
    observationHash: 'a'.repeat(64),
    durationMs: 0,
    ...overrides,
  };
}

function makeResultItem(overrides: Partial<ResultItem['entity']> = {}): ResultItem {
  return {
    entity: {
      entityId: createCanonicalEntityId('opus-one-2018'),
      canonicalLabel: 'Opus One 2018',
      type: 'wine',
      producer: 'Opus One Winery',
      region: 'Napa Valley',
      country: 'United States',
      closure: 'Cork',
      producerPrestige: 0.96,
      wineType: 'red',
      vintage: 2018,
      priceRange: '$450',
      grapes: ['Cabernet Sauvignon'],
      alcoholPct: 14.5,
      body: 0.8,
      tannin: 0.7,
      acidity: 0.5,
      sweetness: 0.2,
      pairingTags: ['beef'],
      occasion: ['gift'],
      ...overrides,
    },
  } as ResultItem;
}

function makeClaim(
  field: ExtractedClaim['field'],
  value: string,
  category: ExtractedClaim['category'] = 'core_structured_claim',
): ExtractedClaim {
  return {
    id: `${category}:${field}:${value}`,
    category,
    field,
    value,
    normalizedValue: value.toLowerCase().normalize('NFKC'),
    sourceText: value,
  };
}

describe('buildEvidenceRecordsFromFrames', () => {
  it('returns empty array when no frames supplied', () => {
    expect(buildEvidenceRecordsFromFrames([])).toEqual([]);
  });

  it('projects search_result_set into flat records with canonical column names', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [makeResultItem()],
        resultCount: 1,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec['entity_id']).toBe('opus-one-2018');
    expect(rec['canonical_label']).toBe('Opus One 2018');
    expect(rec['producer']).toBe('Opus One Winery');
    expect(rec['region']).toBe('Napa Valley');
    expect(rec['country']).toBe('United States');
    expect(rec['closure']).toBe('Cork');
    expect(rec['producer_prestige']).toBe(0.96);
    expect(rec['wine_type']).toBe('red');
    expect(rec['vintage_year']).toBe(2018);
    expect(rec['price_range']).toBe('$450');
    expect(rec['price_usd']).toBe(450);
    expect(rec['grapes']).toEqual(['Cabernet Sauvignon']);
    expect(rec['alcohol_pct']).toBe(14.5);
    expect(rec['body']).toBe(0.8);
    expect(rec['tannin']).toBe(0.7);
    expect(rec['acidity']).toBe(0.5);
    expect(rec['sweetness']).toBe(0.2);
    expect(rec['pairing']).toEqual(['beef']);
    expect(rec['occasion']).toEqual(['gift']);
  });

  it('verifies price claims against explicit price ranges without collapsing them to the lower bound', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [makeResultItem({ priceRange: '$20-$30' })],
        resultCount: 1,
      },
    });

    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records[0]!['price_range']).toBe('$20-$30');
    expect(records[0]!['price_usd']).toBeUndefined();

    const verification = verifyDeterministic(makeClaim('price_usd', '25'), records);
    expect(verification.verdict).toBe('entailed');
  });

  it('skips tool_error and no_op frames (no verifiable evidence)', () => {
    const errorFrame = makeFrame({
      structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: 'bad' },
    });
    const noopFrame = makeFrame({
      structuredOutput: { kind: 'no_op', reason: 'unknown tool' },
    });
    expect(buildEvidenceRecordsFromFrames([errorFrame, noopFrame])).toEqual([]);
  });

  it('projects drinking_window frame as a single record', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'drinking_window',
        entityId: createCanonicalEntityId('chateau-margaux-2015'),
        window: {
          drinkingWindowStart: 2025,
          drinkingWindowEnd: 2045,
          currentlyDrinkable: true,
          confidence: 'high',
        },
        targetYear: 2026,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records).toHaveLength(1);
    expect(records[0]!['drinking_window_start']).toBe(2025);
    expect(records[0]!['drinking_window_end']).toBe(2045);
    expect(records[0]!['currently_drinkable']).toBe('true');
    expect(records[0]!['target_year']).toBe(2026);
    expect(records[0]!['drinking_window_confidence']).toBe('high');
  });

  it('preserves comparison concept axis evidence instead of only the representative top result', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'comparison_result',
        response: {
          queryType: 'comparison',
          originalQuery: 'Barolo vs Brunello',
          comparisonIntent: 'compare',
          entities: [
            {
              subQuery: 'Barolo',
              comparisonMode: 'concept',
              canonicalConcept: 'Barolo',
              conceptEntityType: 'appellation',
              topResult: makeResultItem({ entityId: createCanonicalEntityId('barolo-rep'), region: 'Italy' }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
            {
              subQuery: 'Brunello',
              comparisonMode: 'concept',
              canonicalConcept: 'Brunello di Montalcino',
              conceptEntityType: 'appellation',
              topResult: makeResultItem({ entityId: createCanonicalEntityId('brunello-rep'), region: 'Italy' }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
          ],
          overallStatus: 'resolved',
          requestId: 'req-compare',
          executionTimeMs: 10,
        },
      },
    });

    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records).toHaveLength(2);
    expect(records[0]!['region']).toBe('Italy');
    expect(records[0]!['appellation']).toBeUndefined();
    expect(records[0]!['comparison_concept']).toBe('Barolo');
    expect(records[0]!['comparison_concept_field']).toBe('appellation');
    expect(records[1]!['region']).toBe('Italy');
    expect(records[1]!['appellation']).toBeUndefined();
    expect(records[1]!['comparison_concept']).toBe('Brunello di Montalcino');
    expect(records[1]!['comparison_concept_field']).toBe('appellation');
  });

  it('keeps primary evidence fields intact when comparison concept metadata is appended', () => {
    const frame = makeFrame({
      structuredOutput: {
        kind: 'comparison_result',
        response: {
          queryType: 'comparison',
          originalQuery: 'Barolo vs Brunello',
          comparisonIntent: 'compare',
          entities: [
            {
              subQuery: 'Barolo',
              comparisonMode: 'concept',
              canonicalConcept: 'Barolo',
              conceptEntityType: 'appellation',
              topResult: makeResultItem({
                entityId: createCanonicalEntityId('barolo-cannubi'),
                appellation: 'Cannubi',
                region: 'Piedmont',
              }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
            {
              subQuery: 'Brunello',
              comparisonMode: 'concept',
              canonicalConcept: 'Brunello di Montalcino',
              conceptEntityType: 'appellation',
              topResult: makeResultItem({
                entityId: createCanonicalEntityId('brunello-castelgiocondo'),
                appellation: 'Castelgiocondo',
                region: 'Tuscany',
              }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
          ],
          overallStatus: 'resolved',
          requestId: 'req-compare-primary',
          executionTimeMs: 10,
        },
      },
    });

    const records = buildEvidenceRecordsFromFrames([frame]);
    expect(records[0]!['appellation']).toBe('Cannubi');
    expect(records[0]!['comparison_concept']).toBe('Barolo');
    expect(records[1]!['appellation']).toBe('Castelgiocondo');
    expect(records[1]!['comparison_concept']).toBe('Brunello di Montalcino');
  });

  it('does not treat comparison concept metadata as an identity mismatch anchor', () => {
    const evidence = buildEvidenceRecordsFromFrames([
      makeFrame({
        structuredOutput: {
          kind: 'comparison_result',
          response: {
            queryType: 'comparison',
            originalQuery: 'Barolo vs Brunello',
            comparisonIntent: 'compare',
            entities: [
              {
                subQuery: 'Barolo',
                comparisonMode: 'concept',
                canonicalConcept: 'Barolo',
                conceptEntityType: 'appellation',
                topResult: makeResultItem({
                  entityId: createCanonicalEntityId('rep-barolo'),
                  canonicalLabel: 'Representative Nebbiolo',
                  producer: 'Benchmark Producer',
                  region: 'Italy',
                }),
                resultCount: 1,
                resolutionStatus: 'resolved',
                allResults: [],
              },
              {
                subQuery: 'Brunello',
                comparisonMode: 'concept',
                canonicalConcept: 'Brunello di Montalcino',
                conceptEntityType: 'appellation',
                topResult: makeResultItem({
                  entityId: createCanonicalEntityId('rep-brunello'),
                  canonicalLabel: 'Representative Sangiovese',
                  producer: 'Benchmark Producer',
                  region: 'Italy',
                }),
                resultCount: 1,
                resolutionStatus: 'resolved',
                allResults: [],
              },
            ],
            overallStatus: 'resolved',
            requestId: 'req-compare-identity',
            executionTimeMs: 10,
          },
        },
      }),
    ]);

    const result = verifyDeterministic(
      makeClaim('canonical_label', 'Barolo', 'identity_claim'),
      evidence,
    );

    expect(result.verdict).toBe('not_entailed');
    expect(result.evidenceAnchor?.field).not.toBe('comparison_concept');
  });

  it('preserves frame order and per-frame result order across multiple frames', () => {
    const frameA = makeFrame({
      toolCallId: 'a',
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [
          makeResultItem({ entityId: createCanonicalEntityId('a-1') }),
          makeResultItem({ entityId: createCanonicalEntityId('a-2') }),
        ],
        resultCount: 2,
      },
    });
    const frameB = makeFrame({
      toolCallId: 'b',
      structuredOutput: {
        kind: 'search_result_set',
        resultSet: [makeResultItem({ entityId: createCanonicalEntityId('b-1') })],
        resultCount: 1,
      },
    });
    const records = buildEvidenceRecordsFromFrames([frameA, frameB]);
    expect(records.map((r) => r['entity_id'])).toEqual(['a-1', 'a-2', 'b-1']);
  });

  it('propagates frame provenance into evidence anchors instead of hardcoding search_wines/0', () => {
    const frame = makeFrame({
      toolCallId: 'req-compare-s4-p1',
      toolName: 'compare_wines',
      structuredOutput: {
        kind: 'comparison_result',
        response: {
          queryType: 'comparison',
          originalQuery: 'Barolo vs Brunello',
          comparisonIntent: 'compare',
          entities: [
            {
              subQuery: 'Barolo',
              comparisonMode: 'entity',
              topResult: makeResultItem({ entityId: createCanonicalEntityId('barolo-entity') }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
            {
              subQuery: 'Brunello',
              comparisonMode: 'entity',
              topResult: makeResultItem({ entityId: createCanonicalEntityId('brunello-entity') }),
              resultCount: 1,
              resolutionStatus: 'resolved',
              allResults: [],
            },
          ],
          overallStatus: 'resolved',
          requestId: 'req-compare',
          executionTimeMs: 10,
        },
      },
    });

    const records = buildEvidenceRecordsFromFrames([frame]);
    const result = verifyDeterministic(makeClaim('canonical_label', 'Opus One 2018', 'identity_claim'), records);
    expect(result.evidenceAnchor?.source).toEqual({
      type: 'tool_observation',
      stepIndex: 4,
      toolName: 'compare_wines',
    });
  });
});
