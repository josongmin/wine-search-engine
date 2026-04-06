import { describe, it, expect } from 'vitest';
import { Planner } from '../../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../../src/domain/query/service/expansion-builder.js';
import type { AmbiguityDictionary } from '../../../src/domain/query/port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../../../src/domain/query/service/anchor-extractor.js';
import type { NLMapper } from '../../../src/domain/attribute/service/nl-mapper.js';

// ── Stub helpers ───────────────────────────────────────────────────────────────

/** AliasMatcher that returns a fixed set of matches keyed by a substring of the query. */
class StubAliasMatcher implements AliasMatcher {
  constructor(private readonly entries: Map<string, AliasMatchResult> = new Map()) {}

  findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const results: AliasMatchResult[] = [];
    for (const [key, result] of this.entries) {
      if (normalizedQuery.includes(key)) {
        results.push(result);
      }
    }
    return Promise.resolve(results.sort((a, b) => b.matchConfidence - a.matchConfidence));
  }
}

function makeMatchResult(
  surfaceForm: string,
  confidence = 0.9,
  entityIds: string[] = [`entity-${surfaceForm.toLowerCase().replace(/\s+/g, '-')}`],
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: entityIds as unknown as AliasMatchResult['entityIds'],
    matchConfidence: confidence,
  };
}

/** AmbiguityDictionary that treats nothing as ambiguous. */
const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: () => Promise.resolve(false),
  getAmbiguityInfo: () => Promise.resolve(null),
};

/** NLMapper stub that returns no constraints. */
const noOpNLMapper: NLMapper = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: () => Promise.resolve([]),
} as unknown as NLMapper;

/** Build a Planner with the given alias entries. */
function makePlanner(
  entries: Map<string, AliasMatchResult> = new Map(),
  dict: AmbiguityDictionary = noAmbiguityDict,
): Planner {
  const aliasMatcher = new StubAliasMatcher(entries);
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  return new Planner(dict, anchorExtractor, expansionBuilder, noOpNLMapper);
}

// ── Query normalization ────────────────────────────────────────────────────────

describe('Planner – query normalization', () => {
  it('surfaces multi-view query normalization for debug visibility', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus-One 18');

    expect(plan.normalizedQueryViews).toBeDefined();
    expect(plan.normalizedQueryViews?.lookupVariants).toEqual(
      expect.arrayContaining(['opusone18', 'opus one 2018']),
    );
  });

  it('lowercases "OPUS ONE"', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('OPUS ONE');
    expect(plan.normalizedQuery).toContain('opus one');
  });

  it('strips Latin accents: "Château Margaux" → contains "chateau margaux"', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Château Margaux');
    expect(plan.normalizedQuery).toContain('chateau margaux');
  });

  it('collapses whitespace: "  Opus   One  " → "opus one"', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('  Opus   One  ');
    expect(plan.normalizedQuery).toBe('opus one');
  });

  it('preserves Korean syllables in NFC – no Jamo decomposition', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('오푸스원 같은 10만원 와인');
    // normalizedQuery must be a string
    expect(typeof plan.normalizedQuery).toBe('string');
    // Must NOT contain decomposed Jamo encoded as \uXXXX (the string should
    // not round-trip to JSON with such sequences).
    expect(plan.normalizedQuery).not.toMatch(/[\u1100-\u11FF\u3130-\u318F]/u);
    // Must still contain the original syllabic block
    expect(plan.normalizedQuery).toContain('오푸스원');
  });

  it('rawQuery is preserved exactly as provided', async () => {
    const raw = '  CHÂTEAU  Margaux  ';
    const planner = makePlanner();
    const plan = await planner.plan(raw);
    expect(plan.rawQuery).toBe(raw);
  });

  it('rawQuery for Korean query is preserved exactly', async () => {
    const raw = '오푸스원 같은 10만원 와인';
    const planner = makePlanner();
    const plan = await planner.plan(raw);
    expect(plan.rawQuery).toBe(raw);
  });
});

// ── plannerVersion ─────────────────────────────────────────────────────────────

describe('Planner – plannerVersion', () => {
  it('plannerVersion is a non-empty string', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');
    expect(typeof plan.plannerVersion).toBe('string');
    expect(plan.plannerVersion.length).toBeGreaterThan(0);
  });
});

// ── Route determination ────────────────────────────────────────────────────────

describe('Planner – route determination', () => {
  it('query with "같은" → route is "mixed"', async () => {
    // Anchor present so Korean mixed markers trigger mixed_query intent
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.9)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸스원 같은 10만원 와인');
    expect(plan.route).toBe('mixed');
  });

  it('query with "비슷한" → route is "mixed"', async () => {
    const entries = new Map([['마고', makeMatchResult('마고', 0.9)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('마고 비슷한 와인');
    expect(plan.route).toBe('mixed');
  });

  it('pure entity name with high-confidence anchor → route is "entity"', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    // No attribute/constraint words → entity_exact → entity
    const plan = await planner.plan('Opus One');
    expect(plan.route).toBe('entity');
  });

  it('attribute-heavy query without entity anchors → route is "hybrid"', async () => {
    // No alias matches → no anchors; constraint keyword present → facet_search → hybrid
    const planner = makePlanner(new Map());
    const plan = await planner.plan('풀바디 레드 와인');
    expect(plan.route).toBe('hybrid');
  });
});

// ── Retrieval mode (Epic 7: producer_browse / region_browse) ───────────────────

describe('Planner – retrieval mode', () => {
  it('strong anchor + "best wines" → producer_browse', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One best wines');
    expect(plan.retrievalMode).toBe('producer_browse');
  });

  it('facet query with hierarchical path (≥2 slashes) → region_browse', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('red wine from france / bordeaux / medoc');
    expect(plan.intent).toBe('facet_search');
    expect(plan.retrievalMode).toBe('region_browse');
  });
});
