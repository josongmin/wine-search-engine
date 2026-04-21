import { describe, expect, it } from 'vitest';
import { parseObservations } from '../service/evidence-parser.js';

describe('parseObservations', () => {
  it('prefers embedded GROUNDING_JSON over truncated pipe summaries', () => {
    const observation = [
      '[RETRIEVAL_QUALITY: reliable]',
      'Found 3 results (showing top 3):',
      '1. Wine A | (id: wine-a) | price: $18.86',
      '2. Wine B | (id: wine-b) | price: $25',
      '[observation summary truncated to preserve grounding JSON]',
      'GROUNDING_JSON: {"query_type":"search","total_results":3,"wines":[{"entity_id":"wine-a","canonical_label":"Wine A","price_usd":18.86,"price_krw_approx":25461},{"entity_id":"wine-b","canonical_label":"Wine B","wine_type":"red","vintage":2022},{"entity_id":"wine-c","canonical_label":"Wine C","wine_type":"white","vintage":2023,"alcohol_pct":9.5,"sweetness":0.8}]}',
      '[ALCOHOL_FILTER: 12% 초과로 확인된 1개 결과를 제외했습니다.]',
    ].join('\n');

    const records = parseObservations([observation]);

    expect(records.map((record) => record['entity_id'])).toEqual(['wine-a', 'wine-b', 'wine-c']);
    expect(records[0]?.['price_usd']).toBe(18.86);
    expect(records[2]?.['wine_type']).toBe('white');
    expect(records[2]?.['vintage_year']).toBe(2023);
    expect(records[2]?.['alcohol_pct']).toBe(9.5);
    expect(records[2]?.['sweetness']).toBe(0.8);
  });
});
