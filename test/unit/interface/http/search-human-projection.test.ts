import { describe, expect, it } from 'vitest';
import { projectToHumanResponse } from '../../../../src/interface/http/routes/search-human-projection.js';
import { SearchResponseV2HumanSchema } from '../../../../src/interface/http/schemas/search-response-v2.schema.js';
import type { ComparisonSearchResponse } from '../../../../src/domain/response/model/comparison-response.js';
import type { ResultItem } from '../../../../src/domain/response/model/result-item.js';

function makeResultItem(
  canonicalLabel: string,
  relevanceScore: number,
): ResultItem {
  return {
    entity: {
      entityId: canonicalLabel.toLowerCase().replace(/\s+/gu, '-'),
      canonicalLabel,
      type: 'wine',
    },
    relevanceScore,
    match: {
      matchType: 'semantic',
      scoreComponents: {
        lexical: 0.2,
        semantic: 0.8,
        attribute: 0.4,
        popularity: 0.1,
      },
    },
    constraints: {
      matched: [],
      unmet: [],
      inferred: [],
    },
    uncertainty: {
      missingInfo: [],
      approximationUsed: false,
    },
    evidenceItems: [
      {
        type: 'entity',
        source: 'fixture',
        contribution: 'matched label',
        strength: 'high',
        provenance: 'fixture',
      },
    ],
  } as ResultItem;
}

describe('search human projection', () => {
  it('preserves intrinsic per-result confidence on comparison responses', () => {
    const representative = makeResultItem('Benchmark Barolo', 0.42);
    const prototype = makeResultItem('Benchmark Barolo Riserva', 0.77);
    const comparison: ComparisonSearchResponse = {
      queryType: 'comparison',
      originalQuery: 'Barolo vs Brunello',
      comparisonIntent: 'compare',
      overallStatus: 'resolved',
      entities: [
        {
          subQuery: 'Barolo',
          comparisonMode: 'concept',
          canonicalConcept: 'Barolo',
          conceptEntityType: 'appellation',
          conceptAggregate: {
            canonicalConcept: 'Barolo',
            conceptEntityType: 'appellation',
            representativeResult: representative,
            prototypeAxis: [representative, prototype],
            aggregateResultCount: 2,
          },
          topResult: representative,
          resultCount: 2,
          resolutionStatus: 'resolved',
          allResults: [representative, prototype],
        },
        {
          subQuery: 'Brunello',
          topResult: makeResultItem('Benchmark Brunello', 0.61),
          resultCount: 1,
          resolutionStatus: 'resolved',
          allResults: [makeResultItem('Benchmark Brunello', 0.61)],
        },
      ],
      requestId: 'req-compare',
      executionTimeMs: 12,
      runtimeCorrelationRef: 'req-compare',
    };

    const projected = projectToHumanResponse(comparison, 'req-compare');
    const parsed = SearchResponseV2HumanSchema.parse(projected);
    expect(parsed.queryType).toBe('comparison');
    if (parsed.queryType !== 'comparison') {
      throw new Error('expected comparison response');
    }

    expect(parsed.entities[0].topResult?.confidence).toBeCloseTo(0.42, 6);
    expect(parsed.entities[0].conceptAggregate?.representativeResult?.confidence).toBeCloseTo(0.42, 6);
    expect(parsed.entities[0].conceptAggregate?.prototypeAxis[1]?.confidence).toBeCloseTo(0.77, 6);
    expect(parsed.entities[1].topResult?.confidence).toBeCloseTo(0.61, 6);
  });
});
