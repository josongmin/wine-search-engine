import { describe, expect, it } from 'vitest';
import {
  buildLookupV2RuntimeSurfaceOwnerEvidence,
  buildReviewedCollisionFamilyCoreKeysByEntity,
} from '../../../scripts/eval/lookup-v2-runtime-surface-owner-evidence.js';

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
    expect(evidence.uniqueOwnerWitnesses.get('calon segur')).toEqual([
      {
        entityId: 'wine-a',
        witnessSurface: 'Calon Segur',
        witnessSource: 'aliases_noisy_recall',
      },
    ]);
    expect(evidence.uniqueOwnerWitnesses.get('calon segur 2010')).toEqual([
      {
        entityId: 'wine-a',
        witnessSurface: 'Calon Segur 2010',
        witnessSource: 'aliases_identity_safe',
      },
      {
        entityId: 'wine-a',
        witnessSurface: 'Calon Segur 2010',
        witnessSource: 'canonical_label',
      },
    ]);
    expect(evidence.collidingOwnerWitnesses.get('angelus')).toEqual([
      {
        entityId: 'wine-b',
        witnessSurface: 'Angelus',
        witnessSource: 'aliases_noisy_recall',
      },
      {
        entityId: 'wine-c',
        witnessSurface: 'Angelus',
        witnessSource: 'aliases_noisy_recall',
      },
    ]);
  });

  it('uses producer surfaces as evidence-only family witnesses', () => {
    const evidence = buildLookupV2RuntimeSurfaceOwnerEvidence([
      {
        entityId: 'wine-bollinger',
        canonicalLabel: '2019 Bollinger La Côte Aux Enfants (Aÿ Rouge)',
        producer: 'Bollinger',
        region: 'Champagne',
        attributeHints: { appellation: 'Champagne' },
        aliasesIdentitySafe: ['2019 Bollinger La Côte Aux Enfants (Aÿ Rouge)'],
        aliasesNoisyRecall: [],
      },
      {
        entityId: 'wine-silver-oak-alexander',
        canonicalLabel: '1984 Silver Oak Alexander Valley Cabernet Sauvignon',
        producer: 'Silver Oak',
        region: 'United States',
        attributeHints: { appellation: 'Alexander Valley' },
        aliasesIdentitySafe: ['Silver Oak Alexander Valley Cabernet Sauvignon'],
        aliasesNoisyRecall: [],
      },
      {
        entityId: 'wine-silver-oak-napa',
        canonicalLabel: '2014 Silver Oak Napa Valley Cabernet Sauvignon',
        producer: 'Silver Oak',
        region: 'United States',
        attributeHints: { appellation: 'Napa Valley' },
        aliasesIdentitySafe: ['Silver Oak Napa Valley Cabernet Sauvignon'],
        aliasesNoisyRecall: [],
      },
    ]);

    expect(evidence.uniqueOwners.get('bollinger')).toBe('wine-bollinger');
    expect(evidence.entityProducers.get('wine-bollinger')).toBe('Bollinger');
    expect(evidence.entityRegions.get('wine-silver-oak-alexander')).toBe('United States');
    expect(evidence.uniqueOwnerWitnesses.get('bollinger')).toEqual([
      {
        entityId: 'wine-bollinger',
        witnessSurface: 'Bollinger',
        witnessSource: 'producer',
      },
    ]);
    expect(evidence.collidingOwners.get('silver oak')).toEqual([
      'wine-silver-oak-alexander',
      'wine-silver-oak-napa',
    ]);
    expect(evidence.collidingOwnerWitnesses.get('silver oak')).toEqual([
      {
        entityId: 'wine-silver-oak-alexander',
        witnessSurface: 'Silver Oak',
        witnessSource: 'producer',
      },
      {
        entityId: 'wine-silver-oak-napa',
        witnessSurface: 'Silver Oak',
        witnessSource: 'producer',
      },
    ]);
  });

  it('uses familyCoreKeys as evidence-only witnesses without promoting broad recall', () => {
    const evidence = buildLookupV2RuntimeSurfaceOwnerEvidence([
      {
        entityId: 'wine-calon-segur',
        canonicalLabel: '2003 Château Calon-Ségur Saint-Estèphe (Grand Cru Classé)',
        familyCoreKeys: ['calon-ségur', 'calon segur'],
        aliasesIdentitySafe: ['Chateau Calon-Segur'],
        aliasesNoisyRecall: ['France / France Cabernet Sauvignon'],
      },
      {
        entityId: 'wine-hill-of-grace',
        canonicalLabel: 'Henschke Hill of Grace 2018',
        familyCoreKeys: ['hill of grace'],
        aliasesIdentitySafe: ['Henschke Hill of Grace 2018'],
        aliasesNoisyRecall: [],
      },
    ]);

    expect(evidence.uniqueOwners.get('calon segur')).toBe('wine-calon-segur');
    expect(evidence.uniqueOwnerWitnesses.get('calon segur')).toEqual([
      {
        entityId: 'wine-calon-segur',
        witnessSurface: 'calon segur',
        witnessSource: 'family_core_key',
      },
    ]);
    expect(evidence.uniqueOwners.get('hill of grace')).toBe('wine-hill-of-grace');
    expect(evidence.uniqueOwnerWitnesses.get('hill of grace')).toEqual([
      {
        entityId: 'wine-hill-of-grace',
        witnessSurface: 'hill of grace',
        witnessSource: 'family_core_key',
      },
    ]);
    expect(evidence.uniqueOwners.has('france france cabernet sauvignon')).toBe(false);
  });

  it('applies reviewed family-core witness overlays as evidence-only unique and colliding owners', () => {
    const evidence = buildLookupV2RuntimeSurfaceOwnerEvidence(
      [
        {
          entityId: 'wine-beaucastel-flagship',
          canonicalLabel: '1989 Château de Beaucastel Châteauneuf-du-Pape',
          aliasesIdentitySafe: ['1989 Château de Beaucastel Châteauneuf-du-Pape'],
          aliasesNoisyRecall: [],
        },
        {
          entityId: 'wine-beaucastel-coudoulet',
          canonicalLabel: '2007 Château de Beaucastel Coudoulet de Beaucastel Côtes-du-Rhône',
          aliasesIdentitySafe: ['2007 Château de Beaucastel Coudoulet de Beaucastel Côtes-du-Rhône'],
          aliasesNoisyRecall: [],
        },
        {
          entityId: 'wine-solaia',
          canonicalLabel: "2018 Antinori Tenuta Tignanello 'Solaia'",
          aliasesIdentitySafe: ["2018 Antinori Tenuta Tignanello 'Solaia'"],
          aliasesNoisyRecall: [],
        },
      ],
      [
        {
          surface: 'beaucastel',
          normalizedSurface: 'beaucastel',
          entityId: 'wine-beaucastel-flagship',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T21:35:00.000Z',
          decisionReason: 'family collision witness',
          evidenceClass: 'family_core_witness_review',
        },
        {
          surface: 'beaucastel',
          normalizedSurface: 'beaucastel',
          entityId: 'wine-beaucastel-coudoulet',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T21:35:00.000Z',
          decisionReason: 'family collision witness',
          evidenceClass: 'family_core_witness_review',
        },
        {
          surface: 'solaia',
          normalizedSurface: 'solaia',
          entityId: 'wine-solaia',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T21:35:00.000Z',
          decisionReason: 'singleton family witness',
          evidenceClass: 'family_core_witness_review',
        },
      ],
    );

    expect(evidence.collidingOwners.get('beaucastel')).toEqual([
      'wine-beaucastel-coudoulet',
      'wine-beaucastel-flagship',
    ]);
    expect(evidence.collidingOwnerWitnesses.get('beaucastel')).toEqual([
      {
        entityId: 'wine-beaucastel-coudoulet',
        witnessSurface: 'beaucastel',
        witnessSource: 'reviewed_family_core_registry',
      },
      {
        entityId: 'wine-beaucastel-flagship',
        witnessSurface: 'beaucastel',
        witnessSource: 'reviewed_family_core_registry',
      },
    ]);
    expect(evidence.uniqueOwners.get('solaia')).toBe('wine-solaia');
    expect(evidence.uniqueOwnerWitnesses.get('solaia')).toEqual([
      {
        entityId: 'wine-solaia',
        witnessSurface: 'solaia',
        witnessSource: 'reviewed_family_core_registry',
      },
    ]);
  });

  it('promotes reviewed collision surfaces into family-core overlays for all active owners', () => {
    const reviewedFamilyCoreKeysByEntity = buildReviewedCollisionFamilyCoreKeysByEntity({
      documents: [
        {
          entityId: 'wine-silver-oak-alexander',
          canonicalLabel: '1984 Silver Oak Alexander Valley Cabernet Sauvignon',
          producer: 'Silver Oak',
          aliasesIdentitySafe: ['Silver Oak Alexander Valley Cabernet Sauvignon'],
          aliasesNoisyRecall: [],
          familyCoreKeys: ['alexander valley cabernet sauvignon'],
        },
        {
          entityId: 'wine-silver-oak-napa',
          canonicalLabel: '2014 Silver Oak Napa Valley Cabernet Sauvignon',
          producer: 'Silver Oak',
          aliasesIdentitySafe: ['Silver Oak Napa Valley Cabernet Sauvignon'],
          aliasesNoisyRecall: [],
          familyCoreKeys: ['napa valley cabernet sauvignon'],
        },
      ],
      reviewedCollisionRows: [
        {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'collision',
          evidenceClass: 'collision_support_review',
        },
      ],
    });

    expect(reviewedFamilyCoreKeysByEntity).toEqual(new Map([
      ['wine-silver-oak-alexander', ['silver oak']],
      ['wine-silver-oak-napa', ['silver oak']],
    ]));
  });

  it('fails closed when a reviewed collision overlay row has no active collision owners', () => {
    expect(() => buildReviewedCollisionFamilyCoreKeysByEntity({
      documents: [
        {
          entityId: 'wine-bollinger',
          canonicalLabel: '2019 Bollinger La Cote Aux Enfants',
          producer: 'Bollinger',
          aliasesIdentitySafe: ['Bollinger La Cote Aux Enfants'],
          aliasesNoisyRecall: [],
        },
      ],
      reviewedCollisionRows: [
        {
          benchmarkGoldHint: 'bollinger',
          normalizedBenchmarkGoldHint: 'bollinger',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'collision',
          evidenceClass: 'collision_support_review',
        },
      ],
    })).toThrow(/no active collision owners/i);
  });
});
