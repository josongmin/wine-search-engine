import { describe, expect, it, vi } from 'vitest';
import { MultiChannelRetrievalEngine } from '../../../src/application/search/entity-lookup-v2/multi-channel-retrieval-engine.js';
import { wrapEntityDocumentLookupAsResolverProjection } from '../../../src/application/search/__tests__/resolver-projection-lookup.stub.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { AliasMatcher, AliasMatchResult } from '../../../src/domain/query/service/anchor-extractor.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';
import type { LookupRetrievalInput } from '../../../src/domain/resolver/v2/lookup-v2-types.js';

function views(over: Partial<NormalizedQueryViews> = {}): NormalizedQueryViews {
  return {
    raw: 'Opus One', strict: 'opus one', accentless: 'opus one', collapsedWhitespace: 'opus one',
    punctuationStripped: 'opus one', compact: 'opusone', vintageCanonicalized: 'opus one',
    vintageStripped: 'opus one', semanticVariants: ['opus one'], lookupVariants: ['opus one'],
    ...over,
  };
}

function input(over: Partial<LookupRetrievalInput> = {}): LookupRetrievalInput {
  return { rawQuery: 'Opus One', views: views(), queryClass: 'known-item', maxCandidates: 10, ...over };
}

const opus = createEntityId('opus-one-2018');

function matcherReturning(byView: Record<string, AliasMatchResult[]>): AliasMatcher {
  return {
    findMatches: vi.fn(async (q: string) => byView[q] ?? []),
  };
}

const entityDocumentLookup = {
  getDocuments: vi.fn(async (ids: readonly ReturnType<typeof createEntityId>[]) => {
    const m = new Map();
    for (const id of ids) m.set(id, { entityId: id, entityType: 'wine', canonicalLabel: 'Opus One 2018' });
    return m;
  }),
};
const resolverProjectionLookup = wrapEntityDocumentLookupAsResolverProjection(entityDocumentLookup);

describe('MultiChannelRetrievalEngine (T-ELV2-04 real)', () => {
  it('runs independent channels per view with REAL latency + scores and unions provenance', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97, lookupStrategy: 'exact' }],
      opusone: [{ surfaceForm: 'OpusOne', normalizedForm: 'opusone', entityIds: [opus], matchConfidence: 0.93, lookupStrategy: 'compact_exact' }],
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });

    const result = await engine.retrieve(input());

    // candidate unioned across the strict + compact channels
    expect(result.candidates).toHaveLength(1);
    const cand = result.candidates[0];
    expect(cand?.entityId).toBe(opus);
    expect(cand?.canonicalLabel).toBe('Opus One 2018');
    expect(cand?.entityType).toBe('wine');
    const channels = (cand?.channelHits ?? []).map((h) => h.channel).sort();
    expect(channels).toEqual(['compact_exact', 'exact_alias']);

    // coverage rail: real, NOT latencyMs:0 reprojection — firing channels timed
    const fired = result.coverage.filter((c) => c.firing);
    expect(fired.map((c) => c.channel).sort()).toEqual(['compact_exact', 'exact_alias']);
    expect(fired.every((c) => c.hitCount === 1)).toBe(true);
    expect(fired.every((c) => Number.isFinite(c.latencyMs) && c.latencyMs >= 0)).toBe(true);
  });

  it('reports a dormant channel (firing=false) when its view yields no hits', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97 }],
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });
    const result = await engine.retrieve(input({ views: views({ transliterated: 'opus uno' }) }));
    const translit = result.coverage.find((c) => c.channel === 'transliteration_exact');
    expect(translit?.firing).toBe(false);
    expect(translit?.hitCount).toBe(0);
  });

  it('hydrates candidates from resolver projections directly', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97, lookupStrategy: 'exact' }],
    });
    const resolverProjectionLookup = {
      getResolverProjections: vi.fn(async (ids: readonly ReturnType<typeof createEntityId>[]) => {
        const m = new Map();
        for (const id of ids) {
          m.set(id, {
            entityId: id,
            entityType: 'wine',
            canonicalLabel: 'Opus One 2018',
            aliasesIdentitySafe: ['Opus One'],
            identitySafeKeys: ['opus one'],
          });
        }
        return m;
      }),
    };
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });

    const result = await engine.retrieve(input());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.canonicalLabel).toBe('Opus One 2018');
    expect(resolverProjectionLookup.getResolverProjections).toHaveBeenCalledTimes(1);
  });

  it('caps the union to maxCandidates by best channel score', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => createEntityId(`e-${i}`));
    const matcher = matcherReturning({
      'opus one': ids.map((id, i) => ({ surfaceForm: `E${i}`, normalizedForm: 'opus one', entityIds: [id], matchConfidence: 0.9 - i * 0.1 })),
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });
    const result = await engine.retrieve(input({ maxCandidates: 2 }));
    expect(result.candidates).toHaveLength(2);
  });

  it('survives a single channel throwing (firing=false, union from the rest)', async () => {
    const matcher: AliasMatcher = {
      findMatches: vi.fn(async (q: string) => {
        if (q === 'opusone') throw new Error('compact channel down');
        return [{ surfaceForm: 'Opus One', normalizedForm: q, entityIds: [opus], matchConfidence: 0.97 }];
      }),
    };
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });
    const result = await engine.retrieve(input());
    expect(result.candidates).toHaveLength(1);
    const compact = result.coverage.find((c) => c.channel === 'compact_exact');
    expect(compact?.firing).toBe(false);
  });

  // T-04 honest provenance: the per-candidate channel comes from the matcher's
  // REAL lookupStrategy, NOT the view binding — so a fuzzy/lexical recall on the
  // strict view is labeled fuzzy_alias, never forged as exact_alias.
  function channelsFor(strategy: string | undefined): Promise<readonly string[]> {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.8, ...(strategy !== undefined ? { lookupStrategy: strategy } : {}) }],
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });
    return engine.retrieve(input()).then((r) => (r.candidates[0]?.channelHits ?? []).map((h) => h.channel).sort());
  }

  it('labels transliterated_fuzzy on the strict view as fuzzy_alias (not exact)', async () => {
    expect(await channelsFor('transliterated_fuzzy')).toEqual(['fuzzy_alias']);
  });

  it('labels lexical_exact as fuzzy_alias (recall, not identity) — from strategy not binding', async () => {
    expect(await channelsFor('lexical_exact')).toEqual(['fuzzy_alias']);
  });

  it('strips the index_ prefix the SearchIndex matcher adds (index_transliterated_fuzzy → fuzzy_alias)', async () => {
    expect(await channelsFor('index_transliterated_fuzzy')).toEqual(['fuzzy_alias']);
  });

  it('decomposes a compound strategy into distinct channels (exact+transliterated_fuzzy)', async () => {
    expect(await channelsFor('exact+transliterated_fuzzy')).toEqual(['exact_alias', 'fuzzy_alias']);
  });

  it('falls back to the binding channel only when the matcher emits no strategy', async () => {
    // strict view binding is exact_alias; no lookupStrategy → fallback.
    expect(await channelsFor(undefined)).toEqual(['exact_alias']);
  });
});

// T-ELV2-06 Half B: producer family graph recall channel.
describe('MultiChannelRetrievalEngine — family_graph channel', () => {
  function familyGraphReturning(byAnchor: Record<string, { entityId: string; edgeWeight: number }[]>) {
    return {
      async getRelatedEntitiesBatch(ids: readonly string[], relationKind: string) {
        const m = new Map<string, readonly { targetEntityId: string; relationKind: 'family'; weight: number; familyKey: string }[]>();
        if (relationKind !== 'family') {
          return m;
        }
        for (const id of ids) {
          if (byAnchor[id] === undefined) continue;
          m.set(id, byAnchor[id].map((edge) => ({
            targetEntityId: edge.entityId,
            relationKind: 'family' as const,
            weight: edge.edgeWeight,
            familyKey: 'family',
          })));
        }
        return m;
      },
    };
  }

  it('emits co-producer siblings on the family_graph channel with the edge weight', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97, lookupStrategy: 'exact' }],
    });
    const familyGraph = familyGraphReturning({ 'opus-one-2018': [{ entityId: 'opus-one-2019', edgeWeight: 0.5 }] });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup, entityScopeGraph: familyGraph });
    const result = await engine.retrieve(input());
    const sibling = result.candidates.find((c) => String(c.entityId) === 'opus-one-2019');
    expect(sibling).toBeDefined();
    expect(sibling?.channelHits.some((h) => h.channel === 'family_graph' && h.channelScore === 0.5)).toBe(true);
    const fam = result.coverage.find((c) => c.channel === 'family_graph');
    expect(fam?.firing).toBe(true);
    expect(fam?.hitCount).toBe(1);
  });

  it('reserves a budget so a family-only sibling is not truncated by higher-scoring alias anchors', async () => {
    const e1 = createEntityId('e1');
    const e2 = createEntityId('e2');
    const matcher = matcherReturning({
      'opus one': [
        { surfaceForm: 'E1', normalizedForm: 'opus one', entityIds: [e1], matchConfidence: 0.9, lookupStrategy: 'exact' },
        { surfaceForm: 'E2', normalizedForm: 'opus one', entityIds: [e2], matchConfidence: 0.8, lookupStrategy: 'exact' },
      ],
    });
    // e1 has a family sibling 'e1-sib' at edge weight 0.5 (below both anchors).
    const familyGraph = familyGraphReturning({ e1: [{ entityId: 'e1-sib', edgeWeight: 0.5 }] });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup, entityScopeGraph: familyGraph });
    // maxCandidates=2: a pure best-score slice would keep {e1, e2} and drop the sibling.
    const result = await engine.retrieve(input({ maxCandidates: 2 }));
    const keys = result.candidates.map((c) => String(c.entityId));
    expect(keys).toContain('e1-sib'); // reserved slot kept the family-only sibling
    expect(keys).toContain('e1');
  });

  it('does not fire the family_graph channel when no family graph is wired', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97 }],
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup });
    const result = await engine.retrieve(input());
    expect(result.coverage.some((c) => c.channel === 'family_graph')).toBe(false);
  });

  it('suppresses family_graph expansion for deterministic singleton alias witnesses', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 1, lookupStrategy: 'exact' }],
    });
    const familyGraph = familyGraphReturning({ 'opus-one-2018': [{ entityId: 'opus-one-2019', edgeWeight: 0.5 }] });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup, entityScopeGraph: familyGraph });
    const result = await engine.retrieve(input({ suppressFamilyGraphExpansion: true }));
    expect(result.candidates.map((candidate) => String(candidate.entityId))).not.toContain('opus-one-2019');
    expect(result.coverage.some((c) => c.channel === 'family_graph')).toBe(false);
  });

  it('survives a family graph that throws (request not sunk; alias union stands)', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97 }],
    });
    const familyGraph = { async getRelatedEntitiesBatch(): Promise<never> { throw new Error('family graph down'); } };
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, resolverProjectionLookup, entityScopeGraph: familyGraph });
    const result = await engine.retrieve(input());
    expect(result.candidates).toHaveLength(1);
    const fam = result.coverage.find((c) => c.channel === 'family_graph');
    expect(fam?.firing).toBe(false);
  });

  it('injects reviewed family recall seeds as dense recall-only provenance without forging exact alias evidence', async () => {
    const matcher = matcherReturning({});
    const reviewedFamilyRecall = {
      findMatches: vi.fn(() => [{
        normalizedSurface: 'silver oak',
        familyKey: 'silver oak',
        entityIds: ['silver-oak-alexander', 'silver-oak-napa'],
        recallWeight: 0.5,
        localizedSurfaces: ['실버 오크', '실버오크'],
      }]),
    };
    const engine = new MultiChannelRetrievalEngine({
      aliasMatcher: matcher,
      resolverProjectionLookup,
      reviewedFamilyRecall,
    });

    const result = await engine.retrieve(input({
      rawQuery: '실버 오크 17',
      views: views({
        raw: '실버 오크 17',
        strict: '실버 오크 17',
        accentless: '실버 오크 17',
        collapsedWhitespace: '실버 오크 17',
        punctuationStripped: '실버 오크 17',
        compact: '실버오크17',
        vintageCanonicalized: '실버 오크 2017',
        vintageStripped: '실버 오크',
        transliterated: 'silver oak 17',
        semanticVariants: ['실버 오크 17'],
        lookupVariants: ['실버 오크 17'],
      }),
    }));

    expect(result.candidates.map((candidate) => String(candidate.entityId)).sort()).toEqual([
      'silver-oak-alexander',
      'silver-oak-napa',
    ]);
    expect(result.candidates.every((candidate) =>
      candidate.channelHits.some((hit) => hit.channel === 'dense' && hit.channelScore === 0.5)
    )).toBe(true);
    const dense = result.coverage.find((coverage) => coverage.channel === 'dense');
    expect(dense?.firing).toBe(true);
    expect(dense?.hitCount).toBe(2);
  });

  it('infers ko locale for reviewed family recall when locale is omitted but the query is Hangul', async () => {
    const matcher = matcherReturning({});
    const reviewedFamilyRecall = {
      findMatches: vi.fn(() => []),
    };
    const engine = new MultiChannelRetrievalEngine({
      aliasMatcher: matcher,
      resolverProjectionLookup,
      reviewedFamilyRecall,
    });

    await engine.retrieve(input({
      rawQuery: '실버 오크 17',
      views: views({
        raw: '실버 오크 17',
        strict: '실버 오크 17',
        accentless: '실버 오크 17',
        collapsedWhitespace: '실버 오크 17',
        punctuationStripped: '실버 오크 17',
        compact: '실버오크17',
        vintageCanonicalized: '실버 오크 2017',
        vintageStripped: '실버 오크',
        transliterated: 'silver oak 17',
        semanticVariants: ['실버 오크 17'],
        lookupVariants: ['실버 오크 17'],
      }),
    }));

    expect(reviewedFamilyRecall.findMatches).toHaveBeenCalledWith(expect.objectContaining({
      query: '실버 오크 17',
      locale: 'ko',
    }));
  });
});
