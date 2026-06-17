import { describe, expect, it } from 'vitest';
import { canonicalizeAliasSnapshotRecords } from '../../../../src/domain/shared/utils/search-snapshot-canonicalization.js';

describe('canonicalizeAliasSnapshotRecords', () => {
  it('preserves sorted phoneticKeys in canonical alias hash records', () => {
    const canonical = canonicalizeAliasSnapshotRecords([
      {
        aliasId: 'b',
        entityId: 'entity-b',
        value: 'Margaux',
        normalizedValue: 'margaux',
        type: 'alias',
        scope: 'global',
        source: 'fixture',
        sourceTrust: 1,
        confidencePrior: 0.9,
        phoneticKeys: ['MRK'],
      },
      {
        aliasId: 'a',
        entityId: 'entity-a',
        value: 'Opus One',
        normalizedValue: 'opus one',
        type: 'canonical',
        scope: 'global',
        source: 'fixture',
        sourceTrust: 1,
        confidencePrior: 1,
        phoneticKeys: ['APS', 'WRN'],
      },
    ]);

    expect(canonical[0]?.normalizedValue).toBe('margaux');
    expect(canonical[0]?.phoneticKeys).toEqual(['MRK']);
    expect(canonical[1]?.phoneticKeys).toEqual(['APS', 'WRN']);
  });
});
