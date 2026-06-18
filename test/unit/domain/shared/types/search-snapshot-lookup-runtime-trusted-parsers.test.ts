import { describe, expect, it } from 'vitest';
import {
  parseTrustedLookupAmbiguityRuntimeArtifact,
  parseTrustedLookupConceptRedirectRuntimeArtifact,
  parseTrustedLookupEntityProjectionArtifact,
  parseTrustedLookupExactSafeRuntimeArtifact,
} from '../../../../../src/domain/shared/types/search-snapshot-lookup-runtime.js';

describe('search snapshot lookup runtime trusted parsers', () => {
  it('rejects malformed entity projection documents', () => {
    const raw = JSON.stringify({
      schemaVersion: 'lookup_entity_projection.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      documents: [
        {
          entityId: 'wine-a',
          entityType: 'wine',
          producer: 'Producer',
          aliasesIdentitySafe: [],
          aliasesNoisyRecall: [],
          region: 'Region',
          grapes: [],
          searchTextKo: 'ko',
          searchTextEn: 'en',
          semanticSummary: 'summary',
          pairing: [],
          availability: true,
          popularityScore: 1,
        },
      ],
    });

    expect(() =>
      parseTrustedLookupEntityProjectionArtifact(raw, '/tmp/entity.json'),
    ).toThrow(/canonicalLabel is required/);
  });

  it('rejects ambiguity entries with illegal severity', () => {
    const raw = JSON.stringify({
      schemaVersion: 'lookup_ambiguity_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      entries: {
        ambiguous: {
          normalizedForm: 'ambiguous',
          types: ['collision'],
          severity: 'critical',
        },
      },
    });

    expect(() =>
      parseTrustedLookupAmbiguityRuntimeArtifact(raw, '/tmp/ambiguity.json'),
    ).toThrow(/severity is invalid/);
  });

  it('rejects concept redirect entries with illegal locale', () => {
    const raw = JSON.stringify({
      schemaVersion: 'lookup_concept_redirect_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      entries: {
        concept: {
          normalizedForm: 'concept',
          locale: 'fr',
          conceptClass: 'generic',
          redirectReason: 'concept_query',
          sourceEvidence: 'registry',
        },
      },
    });

    expect(() =>
      parseTrustedLookupConceptRedirectRuntimeArtifact(raw, '/tmp/concept.json'),
    ).toThrow(/locale is invalid/);
  });

  it('rejects exact-safe entries with illegal certificate payload', () => {
    const raw = JSON.stringify({
      schemaVersion: 'lookup_exact_safe_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      exactEntries: {
        exact: {
          entityId: 'wine-a',
          locale: 'global',
          certificate: {
            kind: 'exact_safe',
            normalizedSurface: 'exact',
            sourceTier: 'curated',
            singleton: false,
            collisionFree: true,
          },
        },
      },
      compactEntries: {},
    });

    expect(() =>
      parseTrustedLookupExactSafeRuntimeArtifact(raw, '/tmp/exact-safe.json'),
    ).toThrow(/singleton\/collisionFree must be true/);
  });
});
