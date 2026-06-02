import { describe, expect, it, vi } from 'vitest';
import { MultiChannelRetrievalEngine } from '../../../src/application/search/entity-lookup-v2/multi-channel-retrieval-engine.js';
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

const entityLookup = {
  getDocument: vi.fn(),
  getDocuments: vi.fn(async (ids: readonly ReturnType<typeof createEntityId>[]) => {
    const m = new Map();
    for (const id of ids) m.set(id, { entityId: id, entityType: 'wine', canonicalLabel: 'Opus One 2018' });
    return m;
  }),
};

describe('MultiChannelRetrievalEngine (T-ELV2-04 real)', () => {
  it('runs independent channels per view with REAL latency + scores and unions provenance', async () => {
    const matcher = matcherReturning({
      'opus one': [{ surfaceForm: 'Opus One', normalizedForm: 'opus one', entityIds: [opus], matchConfidence: 0.97, lookupStrategy: 'exact' }],
      opusone: [{ surfaceForm: 'OpusOne', normalizedForm: 'opusone', entityIds: [opus], matchConfidence: 0.93, lookupStrategy: 'compact_exact' }],
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, entityLookup });

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
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, entityLookup });
    const result = await engine.retrieve(input({ views: views({ transliterated: 'opus uno' }) }));
    const translit = result.coverage.find((c) => c.channel === 'transliteration_exact');
    expect(translit?.firing).toBe(false);
    expect(translit?.hitCount).toBe(0);
  });

  it('caps the union to maxCandidates by best channel score', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => createEntityId(`e-${i}`));
    const matcher = matcherReturning({
      'opus one': ids.map((id, i) => ({ surfaceForm: `E${i}`, normalizedForm: 'opus one', entityIds: [id], matchConfidence: 0.9 - i * 0.1 })),
    });
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, entityLookup });
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
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, entityLookup });
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
    const engine = new MultiChannelRetrievalEngine({ aliasMatcher: matcher, entityLookup });
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
