/**
 * Regression guard for dual-lane-fusion `mergeCandidates` field-merge policy.
 *
 * The original implementation manually spread 40+ optional `pickFirstDefined`
 * branches per field. A keys-driven refactor collapsed that to a `for` loop
 * over a `GENERAL_PREFERRED_KEYS` list plus a smaller `GENERAL_ONLY_KEYS`
 * list. This test pins the externally-observable contract:
 *
 *   1. general-only fields appear in the fused candidate
 *   2. entity-only fields appear (general lane absent)
 *   3. when both lanes carry the same field, the general lane wins
 *   4. fields undefined on both lanes are omitted entirely
 *      (NOT set to `undefined` — `exactOptionalPropertyTypes` semantics)
 *   5. ranking signals (sparseRank etc.) propagate ONLY from the general lane
 *   6. the entire HybridCandidate optional-field surface is preserved
 */

import { describe, expect, it } from 'vitest';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { EntityLaneCandidateArtifact } from '../../src/domain/retrieval/model/dual-lane-artifact.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import { fuseDualLaneArtifacts } from '../../src/domain/retrieval/service/dual-lane-fusion.js';

const ENTITY_ID = createCanonicalEntityId('wine-merge-regress');

function makeGeneralCandidate(
  overrides: Partial<HybridCandidate> = {},
): HybridCandidate {
  return {
    entityId: ENTITY_ID,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'fusion',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    },
    ...overrides,
  };
}

function makeEntityArtifact(
  candidateOverrides: Partial<HybridCandidate> = {},
): EntityLaneCandidateArtifact {
  return {
    entityId: ENTITY_ID,
    candidate: {
      entityId: ENTITY_ID,
      matchedConstraints: [],
      retrievalTrace: {
        retrievalProfile: 'entity_route_synthetic',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: ['entity_resolver'],
      },
      identityExactnessTier: 'exact',
      lanePresence: 'entity_only',
      ...candidateOverrides,
    },
    resolvedCandidate: {
      entityId: ENTITY_ID,
      canonicalLabel: 'merge regress',
      calibratedScore: 0.9,
      rank: 1,
      evidenceRefs: ['resolver:merge'],
    },
    identityProvenance: {
      source: 'entity_resolver',
      entityId: ENTITY_ID,
      exactnessTier: 'exact',
      calibratedScore: 0.9,
      resolverRank: 1,
      canonicalLabel: 'merge regress',
      evidenceRefs: ['resolver:merge'],
      sourceSignals: {
        canonicalExactMatch: 1,
        canonicalNormalizedMatch: 1,
        aliasExactMatch: 0,
        aliasFuzzyMatch: 0,
        editDistanceScore: 0,
      },
    },
    evidenceItems: [],
  };
}

describe('dual-lane-fusion mergeCandidates field policy (regression)', () => {
  it('propagates a general-only field into the fused candidate', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact({ producer: undefined })],
      generalLaneCandidates: [
        makeGeneralCandidate({ producer: 'Producer-G' }),
      ],
    });

    expect(fusedCandidates[0]?.producer).toBe('Producer-G');
  });

  it('propagates an entity-only field when the general lane is absent for it', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact({ producer: 'Producer-E' })],
      generalLaneCandidates: [makeGeneralCandidate()],
    });

    expect(fusedCandidates[0]?.producer).toBe('Producer-E');
  });

  it('prefers the general lane when both lanes define the same field', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact({ producer: 'Producer-E' })],
      generalLaneCandidates: [
        makeGeneralCandidate({ producer: 'Producer-G' }),
      ],
    });

    expect(fusedCandidates[0]?.producer).toBe('Producer-G');
  });

  it('omits the key (exactOptionalPropertyTypes) when both lanes are undefined', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact()],
      generalLaneCandidates: [makeGeneralCandidate()],
    });

    const fused = fusedCandidates[0]!;
    // Key must NOT be present — not "present but undefined".
    expect(Object.prototype.hasOwnProperty.call(fused, 'producer')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fused, 'region')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fused, 'criticScoreNormalized')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fused, 'priceUsd')).toBe(false);
  });

  it('propagates ranking signals (sparseRank/denseRank/...) only from the general lane', () => {
    // Even if the entity-lane candidate carried a fake sparseRank, it must be ignored.
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [
        makeEntityArtifact({
          sparseRank: 999,
          denseRank: 999,
          fusionRrfTotal: 999,
        }),
      ],
      generalLaneCandidates: [
        makeGeneralCandidate({
          sparseRank: 1,
          denseRank: 2,
          fusionRrfTotal: 0.5,
        }),
      ],
    });

    const fused = fusedCandidates[0]!;
    expect(fused.sparseRank).toBe(1);
    expect(fused.denseRank).toBe(2);
    expect(fused.fusionRrfTotal).toBe(0.5);
  });

  it('omits ranking signals when the general lane is absent', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [
        makeEntityArtifact({ sparseRank: 1, fusionRrfTotal: 0.5 }),
      ],
      generalLaneCandidates: [],
    });

    const fused = fusedCandidates[0]!;
    expect(Object.prototype.hasOwnProperty.call(fused, 'sparseRank')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fused, 'fusionRrfTotal')).toBe(false);
  });

  it('merges the full HybridCandidate optional surface with general-preferred policy', () => {
    // Broad coverage: 40+ fields populated on both lanes, with the general
    // lane carrying value `G_<field>` and entity lane `E_<field>` (or
    // numeric variants). The fused result must contain the general values
    // for every field listed in GENERAL_PREFERRED_KEYS.
    const general = makeGeneralCandidate({
      canonicalLabel: 'G-label',
      producer: 'G-producer',
      region: 'G-region',
      closure: 'G-closure',
      searchTextEn: 'G-search-en',
      searchTextKo: 'G-search-ko',
      semanticSummary: 'G-summary',
      grapePrimary: 'G-grape',
      grapes: ['G-grape-1', 'G-grape-2'],
      style: 'G-style',
      priceBand: 'G-band',
      pairing: ['G-pair'],
      occasion: ['G-occ'],
      drinkingWindowStart: 2025,
      drinkingWindowEnd: 2035,
      drinkingWindowModelVersion: 'G-v1',
      vintageYear: 2018,
      body: 4,
      tannin: 3,
      acidity: 3,
      sweetness: 1,
      finishLength: 0.8,
      wineType: 'red',
      criticScoreNormalized: 95,
      producerPrestige: 0.9,
      popularityScore: 0.7,
      availability: true,
      country: 'France',
      appellation: 'G-app',
      classification: 'G-class',
      alcoholPct: 14.5,
      priceUsd: 100,
      certifications: ['organic'],
      soilType: 'G-soil',
      flavorProfiles: ['fruity'],
      producerType: 'G-prod-type',
      grapeFamily: 'G-family',
      regionHierarchy: ['Europe', 'France'],
      priceBandNumeric: 3,
      giftSuitabilityScore: 0.6,
      beginnerSuitabilityScore: 0.4,
    });

    const entity = makeEntityArtifact({
      canonicalLabel: 'E-label',
      producer: 'E-producer',
      region: 'E-region',
      closure: 'E-closure',
      searchTextEn: 'E-search-en',
      country: 'Italy',
      criticScoreNormalized: 88,
    });

    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [entity],
      generalLaneCandidates: [general],
    });
    const fused = fusedCandidates[0]!;

    // General wins everywhere it had a value.
    expect(fused.canonicalLabel).toBe('G-label');
    expect(fused.producer).toBe('G-producer');
    expect(fused.region).toBe('G-region');
    expect(fused.closure).toBe('G-closure');
    expect(fused.searchTextEn).toBe('G-search-en');
    expect(fused.searchTextKo).toBe('G-search-ko');
    expect(fused.semanticSummary).toBe('G-summary');
    expect(fused.grapePrimary).toBe('G-grape');
    expect(fused.grapes).toEqual(['G-grape-1', 'G-grape-2']);
    expect(fused.style).toBe('G-style');
    expect(fused.priceBand).toBe('G-band');
    expect(fused.pairing).toEqual(['G-pair']);
    expect(fused.occasion).toEqual(['G-occ']);
    expect(fused.drinkingWindowStart).toBe(2025);
    expect(fused.drinkingWindowEnd).toBe(2035);
    expect(fused.drinkingWindowModelVersion).toBe('G-v1');
    expect(fused.vintageYear).toBe(2018);
    expect(fused.body).toBe(4);
    expect(fused.tannin).toBe(3);
    expect(fused.acidity).toBe(3);
    expect(fused.sweetness).toBe(1);
    expect(fused.finishLength).toBe(0.8);
    expect(fused.wineType).toBe('red');
    expect(fused.criticScoreNormalized).toBe(95);
    expect(fused.producerPrestige).toBe(0.9);
    expect(fused.popularityScore).toBe(0.7);
    expect(fused.availability).toBe(true);
    expect(fused.country).toBe('France');
    expect(fused.appellation).toBe('G-app');
    expect(fused.classification).toBe('G-class');
    expect(fused.alcoholPct).toBe(14.5);
    expect(fused.priceUsd).toBe(100);
    expect(fused.certifications).toEqual(['organic']);
    expect(fused.soilType).toBe('G-soil');
    expect(fused.flavorProfiles).toEqual(['fruity']);
    expect(fused.producerType).toBe('G-prod-type');
    expect(fused.grapeFamily).toBe('G-family');
    expect(fused.regionHierarchy).toEqual(['Europe', 'France']);
    expect(fused.priceBandNumeric).toBe(3);
    expect(fused.giftSuitabilityScore).toBe(0.6);
    expect(fused.beginnerSuitabilityScore).toBe(0.4);
  });

  it('falls back to the entity lane only for fields the general lane left undefined', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [
        makeEntityArtifact({
          producer: 'E-producer',
          region: 'E-region',
          country: 'Italy',
        }),
      ],
      generalLaneCandidates: [
        makeGeneralCandidate({ producer: 'G-producer' }),
      ],
    });
    const fused = fusedCandidates[0]!;

    expect(fused.producer).toBe('G-producer'); // general defined → general
    expect(fused.region).toBe('E-region');     // general undefined → entity
    expect(fused.country).toBe('Italy');       // general undefined → entity
  });

  it('omits retrievalProvenance when both lanes lack it', () => {
    const { fusedCandidates } = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact()],
      generalLaneCandidates: [makeGeneralCandidate()],
    });
    const fused = fusedCandidates[0]!;

    expect(
      Object.prototype.hasOwnProperty.call(fused, 'retrievalProvenance'),
    ).toBe(false);
  });
});
