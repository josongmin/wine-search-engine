import { describe, expect, it, vi } from 'vitest';
import { wrapEntityDocumentBatchLookupAsResolverProjection, type EntityDocumentBatchLookup } from '../../../../src/application/search/__tests__/resolver-projection-lookup.stub.js';
import { buildResolverCandidatesFromGenerator } from '../../../../src/application/search/search-usecase-resolver-candidates.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { CanonicalEntityId } from '../../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../../src/domain/retrieval/model/retrieval-document.js';
import type { LookupResolverProjectionPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { EntityCandidateGeneratorInput } from '../../../../src/domain/resolver/model/entity-candidate-generator-input.js';
import type { AliasType } from '../../../../src/domain/alias/model/alias.js';

/**
 * T-E4-01: Helper to build a batch-capable lookup port from a single-document
 * resolver function. Mirrors the production contract where getDocuments() is
 * the required batch hydration path.
 */
function makeBatchLookup(
  singleFn: (id: CanonicalEntityId) => Promise<RetrievalDocument | null>,
): EntityDocumentBatchLookup {
  return {
    getDocuments: vi.fn(async (ids: readonly CanonicalEntityId[]) => {
      const map = new Map<CanonicalEntityId, RetrievalDocument>();
      for (const id of ids) {
        const doc = await singleFn(id);
        if (doc != null) {
          map.set(id, doc);
        }
      }
      return map;
    }),
  };
}

function makeGeneratorInput(): EntityCandidateGeneratorInput {
  return {
    rawQuery: '오푸스원 2018',
    normalizedQuery: '오푸스원 2018',
    anchors: [
      {
        surfaceForm: '오푸스원',
        normalizedForm: '오푸스원',
        candidateEntityIds: [createEntityId('opus-one-2018')],
        lookupStrategies: ['transliterated_exact'],
        aliasType: 'translation',
        confidence: 0.97,
        source: 'alias',
      },
    ],
  };
}

describe('buildResolverCandidatesFromGenerator', () => {
  it('hydrates resolver candidates via batch getDocuments and preserves provenance signals', async () => {
    const entityId = createEntityId('opus-one-2018');
    const doc = {
      entityId,
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    const lookup = makeBatchLookup(async () => doc);

    const candidates = await buildResolverCandidatesFromGenerator(makeGeneratorInput(), wrapEntityDocumentBatchLookupAsResolverProjection(lookup));

    expect(lookup.getDocuments).toHaveBeenCalledWith([entityId]);
    expect(candidates).toEqual([
      expect.objectContaining({
        entityId,
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasMatches: [
          expect.objectContaining({
            aliasValue: '오푸스원',
            aliasType: 'translation',
            matchScore: 0.97,
          }),
        ],
        sourceSignals: expect.objectContaining({
          canonicalNormalizedMatch: 0.97,
          aliasExactMatch: 0.97,
          aliasFuzzyMatch: 0,
        }),
        source: 'alias',
        sources: ['alias'],
      }),
    ]);
  });

  it('mints exact-like identity evidence from a matched exact-safe certificate even when identitySafeKeys do not carry the Korean surface', async () => {
    const entityId = createEntityId('haut-brion-1967');
    const resolverProjectionLookup: LookupResolverProjectionPort = {
      getResolverProjections: vi.fn(async (ids: readonly CanonicalEntityId[]) => {
        const map = new Map();
        for (const id of ids) {
          map.set(id, {
            entityId,
            entityType: 'wine' as const,
            canonicalLabel: '1967 Château Haut-Brion',
            aliasesIdentitySafe: ['Chateau Haut-Brion'],
            identitySafeKeys: ['chateau haut brion'],
            identityCertificates: [{
              kind: 'exact_safe' as const,
              normalizedSurface: '오브리옹',
              singleton: true,
              collisionFree: true,
              sourceTier: 'curated' as const,
            }],
            attributeHints: {
              producer: 'Château Haut-Brion',
            },
          });
        }
        return map;
      }),
    };

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오브리옹',
        normalizedQuery: '오브리옹',
        anchors: [
          {
            surfaceForm: '오브리옹',
            normalizedForm: '오브리옹',
            candidateEntityIds: [entityId],
            lookupStrategies: ['exact'],
            aliasType: 'observed_query_alias',
            confidence: 0.98,
            source: 'alias',
          },
        ],
      },
      resolverProjectionLookup,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identityCertificates).toEqual([
      expect.objectContaining({
        kind: 'exact_safe',
        normalizedSurface: '오브리옹',
      }),
    ]);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.98);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.98);
    expect(candidates[0]?.sourceSignals.canonicalExactMatch).toBe(1);
  });

  it('merges mixed-source support for the same entity without losing provenance', async () => {
    const entityId = createEntityId('opus-one-2018');
    const doc = {
      entityId,
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    const lookup = makeBatchLookup(async () => doc);

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오푸스원 opus one',
        normalizedQuery: '오푸스원 opus one',
        anchors: [
          {
            ...makeGeneratorInput().anchors[0]!,
            source: 'alias',
          },
          {
            surfaceForm: 'opus one',
            normalizedForm: 'opus one',
            candidateEntityIds: [createEntityId('opus-one-2018')],
            lookupStrategies: ['fuzzy_char_ngram'],
            aliasType: 'misspelling',
            confidence: 0.7,
            source: 'planner_heuristic',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        source: undefined,
        sources: ['alias', 'planner_heuristic'],
      }),
    );
    expect(candidates[0]?.aliasMatches).toHaveLength(2);
  });

  it('does NOT populate the identity-normalized lane for a PURE fuzzy anchor (lane-leak guard)', async () => {
    // Regression: a candidate matched ONLY via a fuzzy strategy (no exactLike
    // strategy in the set) used to leak full anchor confidence into
    // canonicalNormalizedMatch (the identity lane, scorer weight 0.9), because
    // the gate that zeroes that lane only fired for exactLike-that-failed or
    // phonetic — not for fuzzy (identitySafeMatch === undefined). That let a
    // generic token fuzzy hit (e.g. "Viña"→"Vinas") score identity-grade and
    // wrong-resolve a different wine. Fuzzy evidence must flow ONLY through the
    // aliasFuzzyMatch + editDistanceScore lanes; the identity lane is 0.
    const entityId = createEntityId('vinas-mora-kaamen-iii-2022');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: '2022 Vinas Mora kaamen III',
      producer: 'Vinas Mora',
      aliasesIdentitySafe: ['Vinas Mora kaamen III', '2022 Vinas Mora kaamen III'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'Viña Espectro Maipo Valley Carmenere',
        normalizedQuery: 'vina espectro maipo valley carmenere',
        anchors: [
          {
            surfaceForm: '2022 Vinas Mora kaamen III',
            normalizedForm: '2022 vinas mora kaamen iii',
            candidateEntityIds: [entityId],
            lookupStrategies: ['fuzzy_char_ngram'],
            aliasType: 'misspelling',
            confidence: 0.9,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    const signals = candidates[0]?.sourceSignals;
    // identity lanes must be ZERO for a pure-fuzzy hit
    expect(signals?.canonicalNormalizedMatch).toBe(0);
    expect(signals?.canonicalExactMatch).toBe(0);
    expect(signals?.aliasExactMatch).toBe(0);
    // fuzzy evidence still flows through its designed lanes
    expect(signals?.aliasFuzzyMatch).toBeCloseTo(0.9);
    expect(signals?.editDistanceScore).toBeGreaterThan(0);
  });

  it('keeps exact identity signal only for candidates whose identity-safe projection matches the anchor', async () => {
    const grandVinId = createEntityId('chateau-margaux-grand-vin');
    const secondWineId = createEntityId('pavillon-rouge-du-chateau-margaux');
    const docs = new Map<CanonicalEntityId, RetrievalDocument>([
      [grandVinId, {
        entityId: grandVinId,
        entityType: 'wine',
        canonicalLabel: '2022 Château Margaux Château Margaux (Premier Grand Cru Classé)',
        producer: 'Château Margaux',
        aliasesIdentitySafe: ['Château Margaux', 'Château Margaux 2022'],
      } as unknown as RetrievalDocument],
      [secondWineId, {
        entityId: secondWineId,
        entityType: 'wine',
        canonicalLabel: '1982 Château Margaux Pavillon Rouge du Château Margaux',
        producer: 'Château Margaux',
        aliasesIdentitySafe: [
          'Château Margaux',
          'Château Margaux 1982',
          'Pavillon Rouge du Château Margaux',
          'Pavillon Rouge du Château Margaux 1982',
        ],
      } as unknown as RetrievalDocument],
    ]);
    const lookup = makeBatchLookup(async (id) => docs.get(id) ?? null);

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '샤또 마고',
        normalizedQuery: '샤또 마고',
        anchors: [
          {
            surfaceForm: '샤또 마고',
            normalizedForm: '샤또 마고',
            candidateEntityIds: [grandVinId, secondWineId],
            lookupVariants: ['chateau margaux'],
            lookupStrategies: ['transliterated_exact'],
            aliasType: 'translation',
            confidence: 0.97,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    const grandVin = candidates.find((candidate) => candidate.entityId === grandVinId);
    const secondWine = candidates.find((candidate) => candidate.entityId === secondWineId);

    expect(grandVin?.sourceSignals.aliasExactMatch).toBeCloseTo(0.97);
    expect(secondWine?.sourceSignals.aliasExactMatch).toBe(0);
    expect(secondWine?.sourceSignals.canonicalNormalizedMatch).toBe(0);
  });

  it('treats hangul IME completion identity artifacts as exact-like alias evidence', async () => {
    const entityId = createEntityId('opus-one-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      producer: 'Opus One',
      aliasesIdentitySafe: ['Opus One', '오푸스원'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오푸스ㅇ',
        normalizedQuery: '오푸스ㅇ',
        anchors: [
          {
            surfaceForm: 'Opus One',
            normalizedForm: 'opus one',
            candidateEntityIds: [entityId],
            lookupVariants: ['오푸스ㅇ'],
            lookupStrategies: ['hangul_ime_completion', 'transliterated_fuzzy'],
            aliasType: 'translation',
            confidence: 0.97,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.97);
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeCloseTo(0.97);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.97);
  });

  it('does NOT mint exact identity from a single-entity high-confidence prefix_exact anchor when the query is a STRICT prefix of the alias surface', async () => {
    // Hallucination-guard contract (search-usecase-resolver-candidates.ts
    // isStrictPrefixOfAnchorSurface): a bare short form that is only a STRICT,
    // incomplete prefix of a real alias ('opus' ⊂ 'opus one') does NOT uniquely
    // identify the entity, so the trust-the-matcher bypass MUST NOT engage even
    // at confidence >= 0.8. The identity-safe projection then runs, finds the
    // bare prefix is not a query-attested safe alias of 'Opus One', forces
    // exactSignalAllowed=false, and the exact/normalized identity lanes stay
    // zero. Downstream the calibration trust gate downgrades the verdict to
    // 'ambiguous' — see the noisy-runtime regression for the end-to-end pin.
    const entityId = createEntityId('opus-one-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      producer: 'Opus One',
      aliasesIdentitySafe: ['Opus One', '오푸스원'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'opus',
        normalizedQuery: 'opus',
        anchors: [
          {
            surfaceForm: 'Opus One',
            normalizedForm: 'opus one',
            candidateEntityIds: [entityId],
            lookupVariants: ['opus'],
            lookupStrategies: ['prefix_exact'],
            aliasType: 'canonical',
            confidence: 0.95,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.aliasMatches).toEqual([
      expect.objectContaining({
        aliasValue: 'Opus One',
        aliasType: 'canonical',
        matchScore: 0.95,
      }),
    ]);
    // Strict-prefix query → no exact-like identity is minted: the bare prefix
    // is not a complete alias surface, so identity lanes collapse to zero.
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalExactMatch).toBe(0);
  });

  it('mints exact-like identity from a single-entity high-confidence prefix_exact anchor when the query EQUALS the complete (short) alias surface', async () => {
    // Positive companion to the strict-prefix guard above: when the normalized
    // query EQUALS the anchor's complete normalized surface (e.g. a genuinely
    // short single-token alias like 'barolo'), it is NOT a strict prefix, the
    // trust-the-matcher bypass engages, and exact-like identity evidence is
    // minted at anchor.confidence. This preserves clean short-alias lookups
    // while the strict-prefix case ('opus' ⊂ 'opus one') stays ambiguous.
    const entityId = createEntityId('barolo-appellation');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'appellation',
      canonicalLabel: 'Barolo',
      aliasesIdentitySafe: ['Barolo'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'barolo',
        normalizedQuery: 'barolo',
        anchors: [
          {
            surfaceForm: 'Barolo',
            normalizedForm: 'barolo',
            candidateEntityIds: [entityId],
            lookupVariants: ['barolo'],
            lookupStrategies: ['prefix_exact'],
            aliasType: 'canonical',
            confidence: 0.95,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    // Complete-surface query → exact-like identity minted at anchor.confidence.
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.95);
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBe(0);
    // query 'barolo' === normalizedForm 'barolo' → full canonical-exact match.
    expect(candidates[0]?.sourceSignals.canonicalExactMatch).toBe(1);
  });

  it('does NOT mint exact identity evidence from a low-confidence latin bare prefix anchor', async () => {
    // Adversarial guard: below the 0.8 trust floor the single-entity prefix
    // bypass does NOT engage, so the identity-safe projection check runs and
    // finds the bare prefix 'opus' is not a query-attested safe alias of
    // 'Opus One' — exact/normalized identity lanes stay zero.
    const entityId = createEntityId('opus-one-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      producer: 'Opus One',
      aliasesIdentitySafe: ['Opus One', '오푸스원'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'opus',
        normalizedQuery: 'opus',
        anchors: [
          {
            surfaceForm: 'Opus One',
            normalizedForm: 'opus one',
            candidateEntityIds: [entityId],
            lookupVariants: ['opus'],
            lookupStrategies: ['prefix_exact'],
            aliasType: 'canonical',
            confidence: 0.7,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalExactMatch).toBe(0);
  });

  it('treats transliterated prefix identity artifacts as exact-like translation evidence', async () => {
    const entityId = createEntityId('opus-one-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      producer: 'Opus One',
      aliasesIdentitySafe: ['Opus One', '오퍼스 원', '오푸스원'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오퍼스',
        normalizedQuery: '오퍼스',
        anchors: [
          {
            surfaceForm: 'Opus One',
            normalizedForm: 'opus one',
            candidateEntityIds: [entityId],
            lookupVariants: ['오퍼스'],
            lookupStrategies: ['transliterated_prefix'],
            aliasType: 'translation',
            confidence: 0.95,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.aliasMatches).toEqual([
      expect.objectContaining({
        aliasValue: 'Opus One',
        aliasType: 'translation',
        matchScore: 0.95,
      }),
    ]);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.95);
  });

  it('lets compact Korean prefix typos recover explicit opus one identity evidence through query-derived normalization', async () => {
    const entityId = createEntityId('opus-one-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      producer: 'Opus One',
      aliasesIdentitySafe: ['Opus One', '오푸스원'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오푸',
        normalizedQuery: '오푸',
        anchors: [
          {
            surfaceForm: 'Opus One',
            normalizedForm: 'opus one',
            candidateEntityIds: [entityId],
            lookupVariants: ['오푸'],
            lookupStrategies: ['prefix_exact'],
            aliasType: 'translation',
            confidence: 0.95,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.95);
  });

  it('does not treat vintage-bearing safe aliases as bare-label identity seals unless the bare form is explicit', async () => {
    const entityId = createEntityId('sassicaia-2018');
    const lookup = makeBatchLookup(async () => ({
      entityId,
      entityType: 'wine',
      canonicalLabel: 'Sassicaia 2018',
      producer: 'Tenuta San Guido',
      aliasesIdentitySafe: ['Sassicaia 2018', 'sassicaia 2018'],
    } as unknown as RetrievalDocument));

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'sassicaia',
        normalizedQuery: 'sassicaia',
        anchors: [
          {
            surfaceForm: 'Sassicaia',
            normalizedForm: 'sassicaia',
            candidateEntityIds: [entityId],
            lookupVariants: ['sassicaia'],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.95,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceSignals.canonicalExactMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBe(0);
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBe(0);
  });

  it('uses batch getResolverProjections as the sole production hydration path', async () => {
    const entityId = createEntityId('opus-one-2018');
    const getDocuments = vi.fn().mockResolvedValue(
      new Map([
        [entityId, {
          entityId,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasesIdentitySafe: ['Opus One 2018'],
          identityCertificates: [],
        }],
      ]),
    );

    const candidates = await buildResolverCandidatesFromGenerator(
      makeGeneratorInput(),
      wrapEntityDocumentBatchLookupAsResolverProjection({ getDocuments }),
    );

    expect(getDocuments).toHaveBeenCalledWith([entityId]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalLabel).toBe('Opus One 2018');
  });

  it('throws resolver_projection_overlay_failed when projection lookup rejects', async () => {
    const getResolverProjections = vi.fn().mockRejectedValue(new Error('Vespa timeout'));

    await expect(
      buildResolverCandidatesFromGenerator(makeGeneratorInput(), { getResolverProjections }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      message: expect.stringContaining('resolver_projection_overlay_failed'),
    });
  });

  it('throws partial_resolution_forbidden when batch returns incomplete results', async () => {
    const missingId = createEntityId('missing-wine');
    const presentId = createEntityId('present-wine');
    const getDocuments = vi.fn().mockResolvedValue(
      new Map([
        [presentId, {
          entityId: presentId,
          entityType: 'wine',
          canonicalLabel: 'Present Wine',
        }],
      ]),
    );

    const input = {
      rawQuery: '오푸스원',
      normalizedQuery: '오푸스원',
      anchors: [
        {
          surfaceForm: '오푸스원',
          normalizedForm: '오푸스원',
          candidateEntityIds: [presentId, missingId],
          lookupStrategies: ['transliterated_exact'] as const,
          aliasType: 'translation' as const,
          confidence: 0.93,
          source: 'alias' as const,
        },
      ],
    };

    await expect(
      buildResolverCandidatesFromGenerator(input, wrapEntityDocumentBatchLookupAsResolverProjection({ getDocuments })),
    ).rejects.toMatchObject({
      code: 'INTERNAL_INCONSISTENCY',
      message: expect.stringContaining('partial_resolution_forbidden'),
    });
  });

  // inferAliasType is exercised here through the public builder so the
  // observable contract — anchor.aliasType wins over strategy inference —
  // is locked, even though the helper itself is module-private.
  describe('inferAliasType (via builder)', () => {
    function makeAnchorInput(
      anchor: Partial<EntityCandidateGeneratorInput['anchors'][number]> & {
        candidateEntityIds: readonly CanonicalEntityId[];
      },
    ): EntityCandidateGeneratorInput {
      return {
        rawQuery: 'q',
        normalizedQuery: 'q',
        anchors: [
          {
            surfaceForm: 'CM',
            normalizedForm: 'cm',
            confidence: 0.5,
            source: 'alias',
            ...anchor,
          },
        ],
      };
    }

    it('uses anchor.aliasType when explicit (overrides strategy inference)', async () => {
      const entityId = createEntityId('chateau-margaux-2015');
      const doc = { entityId, entityType: 'wine' as const, canonicalLabel: 'Château Margaux 2015' };
      const lookup = makeBatchLookup(async () => doc);
      const candidates = await buildResolverCandidatesFromGenerator(
        makeAnchorInput({
          candidateEntityIds: [entityId],
          // Strategy looks exact-like (would normally infer 'canonical'),
          // but the explicit field MUST win.
          lookupStrategies: ['exact'],
          aliasType: 'derived_initialism',
        }),
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );
      expect(candidates[0]?.aliasMatches[0]?.aliasType).toBe('derived_initialism');
    });

    it('preserves anchors that omit aliasType even when strategy is exact-like', async () => {
      const entityId = createEntityId('chateau-margaux-2015');
      const doc = { entityId, entityType: 'wine' as const, canonicalLabel: 'Château Margaux 2015' };
      const lookup = makeBatchLookup(async () => doc);
      const candidates = await buildResolverCandidatesFromGenerator(
        makeAnchorInput({
          candidateEntityIds: [entityId],
          lookupStrategies: ['exact'],
        }),
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );
      expect(candidates[0]?.aliasMatches[0]).toEqual({
        aliasValue: 'CM',
        matchScore: expect.any(Number),
      });
    });

    it('preserves anchors that omit aliasType for substring strategy', async () => {
      const entityId = createEntityId('chateau-margaux-2015');
      const doc = { entityId, entityType: 'wine' as const, canonicalLabel: 'Château Margaux 2015' };
      const lookup = makeBatchLookup(async () => doc);
      const candidates = await buildResolverCandidatesFromGenerator(
        makeAnchorInput({
          candidateEntityIds: [entityId],
          lookupStrategies: ['substring'],
        }),
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );
      expect(candidates[0]?.aliasMatches[0]?.aliasType).toBeUndefined();
      expect(candidates[0]?.sourceSignals.aliasFuzzyMatch).toBeGreaterThan(0);
    });

    it('preserves anchors that omit aliasType for phonetic strategy', async () => {
      const entityId = createEntityId('chateau-margaux-2015');
      const doc = { entityId, entityType: 'wine' as const, canonicalLabel: 'Château Margaux 2015' };
      const lookup = makeBatchLookup(async () => doc);
      const candidates = await buildResolverCandidatesFromGenerator(
        makeAnchorInput({
          candidateEntityIds: [entityId],
          lookupStrategies: ['phonetic_fuzzy'],
        }),
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );
      expect(candidates[0]?.aliasMatches[0]?.aliasType).toBeUndefined();
      expect(candidates[0]?.sourceSignals.phoneticMatch).toBeGreaterThan(0);
    });

    it('mixed anchors on same entity preserve per-anchor aliasType (canonical + derived_initialism coexist)', async () => {
      // Critical regression guard for the cap-leak bug: two anchors landing
      // on the same entity must each carry their own type so the scorer's
      // `.every()` gate sees the canonical evidence and DOES NOT cap.
      const entityId = createEntityId('masi-amarone');
      const doc = { entityId, entityType: 'wine' as const, canonicalLabel: 'Masi Amarone della Valpolicella' };
      const lookup = makeBatchLookup(async () => doc);
      const candidates = await buildResolverCandidatesFromGenerator(
        {
          rawQuery: 'masi 15',
          normalizedQuery: 'masi 15',
          anchors: [
            {
              surfaceForm: 'Masi Amarone',
              normalizedForm: 'masi amarone',
              candidateEntityIds: [entityId],
              lookupStrategies: ['prefix_exact'],
              aliasType: 'canonical',
              confidence: 0.9,
              source: 'alias',
            },
            {
              surfaceForm: 'MA',
              normalizedForm: 'ma',
              candidateEntityIds: [entityId],
              lookupStrategies: ['prefix_exact'],
              aliasType: 'derived_initialism',
              confidence: 0.5,
              source: 'alias',
            },
          ],
        },
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );
      const types = candidates[0]?.aliasMatches.map((m) => m.aliasType) ?? [];
      expect(types).toContain('canonical');
      expect(types).toContain('derived_initialism');
    });
  });
});

// ─── 수학적 완결성: mergeSignals 교환법칙 · 멱등법칙 · 3-anchor max() ──────────
//
// mergeSignals(left, right) = { field: Math.max(left[field], right[field]) }
// 이 구현은:
//   - 교환법칙: mergeSignals(A, B) = mergeSignals(B, A)  (Math.max 는 대칭)
//   - 멱등법칙: mergeSignals(A, A) = A                  (max(x,x)=x)
//   - 결합법칙: merge(merge(A,B),C) = merge(A,merge(B,C)) (3-anchor 경우)
//
// mergeSignals 는 private 이므로 buildResolverCandidatesFromGenerator 를 통해
// 동일 entityId 의 두 앵커를 순서를 바꿔 입력하여 결과 소스 신호를 비교한다.

describe('mergeSignals — 수학적 속성 (교환법칙 · 멱등법칙 · 3-anchor max)', () => {
  function makeLookup(entityId: string): EntityDocumentBatchLookup {
    const doc = {
      entityId: createEntityId(entityId),
      entityType: 'wine' as const,
      canonicalLabel: 'Test Wine',
    };
    return makeBatchLookup(async () => doc);
  }

  it('MS-COMM-01: 교환법칙 — anchor(A=0.9, B=0.6) vs anchor(B=0.6, A=0.9) 동일 신호', async () => {
    const entityId = 'wine-comm-01';
    const lookup = makeLookup(entityId);

    // A-then-B
    const r1 = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test high',
            normalizedForm: 'test high',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.9, // 높은 confidence
            source: 'alias',
          },
          {
            surfaceForm: 'test low',
            normalizedForm: 'test low',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['fuzzy_char_ngram'],
            aliasType: 'misspelling',
            confidence: 0.6, // 낮은 confidence
            source: 'planner_heuristic',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    // B-then-A (순서 반전)
    const r2 = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test low',
            normalizedForm: 'test low',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['fuzzy_char_ngram'],
            aliasType: 'misspelling',
            confidence: 0.6,
            source: 'planner_heuristic',
          },
          {
            surfaceForm: 'test high',
            normalizedForm: 'test high',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.9,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    // sourceSignals 는 merge 결과 — 교환법칙: 순서 무관하게 동일해야 함
    expect(r1[0]?.sourceSignals).toEqual(r2[0]?.sourceSignals);
  });

  it('MS-IDEM-01: 멱등법칙 — 동일 anchor 두 번 = 한 번의 결과 (max(x,x)=x)', async () => {
    const entityId = 'wine-idem-01';
    const lookup = makeLookup(entityId);
    const sameAnchor = {
      surfaceForm: 'opus one',
      normalizedForm: 'opus one',
      candidateEntityIds: [createEntityId(entityId)],
      lookupStrategies: ['exact' as const],
      aliasType: 'canonical' as AliasType,
      confidence: 0.85,
      source: 'alias' as const,
    };

    // 동일 anchor 1회
    const r1 = await buildResolverCandidatesFromGenerator(
      { rawQuery: 'opus one', normalizedQuery: 'opus one', anchors: [sameAnchor] },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );
    // 동일 anchor 2회 (중복)
    const r2 = await buildResolverCandidatesFromGenerator(
      { rawQuery: 'opus one', normalizedQuery: 'opus one', anchors: [sameAnchor, sameAnchor] },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    // max(0.85, 0.85) = 0.85 — 멱등
    expect(r2[0]?.sourceSignals).toEqual(r1[0]?.sourceSignals);
    // 단일 엔티티
    expect(r2).toHaveLength(1);
  });

  it('MS-MAX-01: 3-anchor merge — max() 가 세 anchor 모두에서 가장 높은 값을 선택', async () => {
    const entityId = 'wine-max-01';
    const lookup = makeLookup(entityId);

    // 세 앵커: confidence = 0.5, 0.8, 0.95
    // aliasExactMatch = confidence (transliterated 전략 아닐 때 exact 전략에서 aliasExactMatch = confidence)
    // canonicalNormalizedMatch 도 confidence 로 설정
    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: 'test',
        normalizedQuery: 'test',
        anchors: [
          {
            surfaceForm: 'test a',
            normalizedForm: 'test a',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.5,
            source: 'alias',
          },
          {
            surfaceForm: 'test b',
            normalizedForm: 'test b',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.95, // 이것이 max 가 되어야 함
            source: 'alias',
          },
          {
            surfaceForm: 'test c',
            normalizedForm: 'test c',
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact'],
            aliasType: 'canonical',
            confidence: 0.8,
            source: 'alias',
          },
        ],
      },
      wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
    );

    expect(candidates).toHaveLength(1);
    // aliasExactMatch 는 세 앵커 중 max → 0.95
    expect(candidates[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    // canonicalNormalizedMatch 도 max → 0.95
    expect(candidates[0]?.sourceSignals.canonicalNormalizedMatch).toBeCloseTo(0.95);
    // aliasMatches 는 3개 모두 보존
    expect(candidates[0]?.aliasMatches).toHaveLength(3);
  });

  it('MS-MAX-02: 3-anchor max — 낮은 confidence 앵커가 마지막에 와도 결과 동일', async () => {
    const entityId = 'wine-max-02';
    const lookup = makeLookup(entityId);

    const makeInput = (order: [number, number, number]) =>
      buildResolverCandidatesFromGenerator(
        {
          rawQuery: 'test',
          normalizedQuery: 'test',
          anchors: order.map((conf, i) => ({
            surfaceForm: `test ${i}`,
            normalizedForm: `test ${i}`,
            candidateEntityIds: [createEntityId(entityId)],
            lookupStrategies: ['exact' as const],
            aliasType: 'canonical' as AliasType,
            confidence: conf,
            source: 'alias' as const,
          })),
        },
        wrapEntityDocumentBatchLookupAsResolverProjection(lookup),
      );

    // 세 순서 모두 동일 결과
    const [r1, r2, r3] = await Promise.all([
      makeInput([0.5, 0.95, 0.8]),
      makeInput([0.95, 0.5, 0.8]),
      makeInput([0.8, 0.5, 0.95]),
    ]);

    expect(r1[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(r2[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
    expect(r3[0]?.sourceSignals.aliasExactMatch).toBeCloseTo(0.95);
  });

  it('hydrates exact-safe certificates from resolver projections even when preloadedDocs already filled the doc map', async () => {
    const entityId = createEntityId('haut-brion-1967');
    const resolverProjectionLookup: LookupResolverProjectionPort = {
      getResolverProjections: vi.fn(async (ids) => new Map(ids.map((id) => [id, {
        entityId: id,
        entityType: 'wine',
        canonicalLabel: '1967 Château Haut-Brion Pessac-Léognan (Premier Grand Cru Classé)',
        aliasesIdentitySafe: ['Haut-Brion', '오브리옹'],
        identityCertificates: [{
          kind: 'exact_safe',
          singleton: true,
          collisionFree: true,
          sourceTier: 'curated',
          normalizedSurface: '오브리옹',
        }],
      }] as const))),
    };

    const preloadedDocs = new Map<string, RetrievalDocument>([
      [String(entityId), {
        entityId,
        entityType: 'wine',
        canonicalLabel: '1967 Château Haut-Brion Pessac-Léognan (Premier Grand Cru Classé)',
        aliasesIdentitySafe: ['Haut-Brion', '오브리옹'],
      } as unknown as RetrievalDocument],
    ]);

    const candidates = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: '오브리옹',
        normalizedQuery: '오브리옹',
        anchors: [
          {
            surfaceForm: '오브리옹',
            normalizedForm: '오브리옹',
            candidateEntityIds: [entityId],
            lookupStrategies: ['exact'],
            aliasType: 'translation',
            confidence: 0.98,
            source: 'alias',
          },
        ],
        preloadedDocs,
      },
      resolverProjectionLookup,
    );

    expect(resolverProjectionLookup.getResolverProjections).toHaveBeenCalledWith([entityId]);
    expect(candidates[0]?.identityCertificates).toEqual([
      expect.objectContaining({
        kind: 'exact_safe',
        singleton: true,
        collisionFree: true,
        normalizedSurface: '오브리옹',
      }),
    ]);
  });
});
