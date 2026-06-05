import { describe, expect, it } from 'vitest';
import { buildLookupV2RuntimeSurfaceOwnerEvidence } from '../../../scripts/eval/lookup-v2-runtime-surface-owner-evidence.js';

describe('buildLookupV2RuntimeSurfaceOwnerEvidence', () => {
  it('tracks unique and colliding normalized owners deterministically', () => {
    const evidence = buildLookupV2RuntimeSurfaceOwnerEvidence([
      {
        entityId: 'wine-a',
        canonicalLabel: 'Calon Segur 2010',
        aliasesIdentitySafe: ['Calon Segur 2010'],
        aliasesNoisyRecall: ['Calon Segur'],
      },
      {
        entityId: 'wine-b',
        canonicalLabel: 'Angelus 2012',
        aliasesIdentitySafe: ['Angelus 2012'],
        aliasesNoisyRecall: ['Angelus'],
      },
      {
        entityId: 'wine-c',
        canonicalLabel: 'Angelus 2015',
        aliasesIdentitySafe: ['Angelus 2015'],
        aliasesNoisyRecall: ['Angelus'],
      },
    ]);

    expect(evidence.uniqueOwners.get('calon segur')).toBe('wine-a');
    expect(evidence.collidingOwners.get('angelus')).toEqual(['wine-b', 'wine-c']);
    expect(evidence.entityLabels.get('wine-a')).toBe('Calon Segur 2010');
  });
});
