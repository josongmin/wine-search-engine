import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';
import { buildLookupV2RuntimeIdentitySafeAliasMap } from '../../../scripts/eval/lookup-v2-runtime-identity-safe-alias-map.js';

describe('buildLookupV2RuntimeIdentitySafeAliasMap', () => {
  it('keeps only unique normalized identity-safe alias owners', () => {
    const map = buildLookupV2RuntimeIdentitySafeAliasMap([
      {
        entityId: 'wine-ce-pol-roger',
        aliasesIdentitySafe: ['Pol Roger', '폴 로저'],
      },
      {
        entityId: 'wine-ce-other',
        aliasesIdentitySafe: ['Other Alias'],
      },
      {
        entityId: 'wine-ce-collision-a',
        aliasesIdentitySafe: ['Shared Alias'],
      },
      {
        entityId: 'wine-ce-collision-b',
        aliasesIdentitySafe: ['shared alias'],
      },
    ]);

    expect(map.get(normalizeForMatch('Pol Roger'))).toBe('wine-ce-pol-roger');
    expect(map.get(normalizeForMatch('폴 로저'))).toBe('wine-ce-pol-roger');
    expect(map.get(normalizeForMatch('Other Alias'))).toBe('wine-ce-other');
    expect(map.has(normalizeForMatch('Shared Alias'))).toBe(false);
  });
});
