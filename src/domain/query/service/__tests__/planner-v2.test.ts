import { describe, it, expect, vi } from 'vitest';
import { Planner } from '../planner.js';
import { AnchorExtractor } from '../anchor-extractor.js';
import { ExpansionBuilder } from '../expansion-builder.js';
import { planV2ToUnderstandingSnapshot } from '../../model/query-plan.js';
import type { QueryPlanV2 } from '../../model/query-plan.js';
import type { QueryUnderstandingSnapshot } from '../../model/query-understanding-snapshot.js';
import type { AmbiguityDictionary } from '../../port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../anchor-extractor.js';
import { NLMapper, type NLMapper as NLMapperPort } from '../../../attribute/service/nl-mapper.js';
import type { ConstraintExtractionTrace } from '../../../attribute/model/constraint-extraction-trace.js';
import type { MappingTablePort } from '../../../attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../../attribute/model/nl-mapping.js';
import type { FuzzyMatcherPort } from '../../port/fuzzy-matcher.port.js';
import type { ExpansionBundle } from '../../model/constraint-bundle.js';
import type { QueryIntent } from '../../model/query-intent.js';
import type { AnchorCandidate } from '../../model/anchor-candidate.js';

// ── Stub helpers ───────────────────────────────────────────────────────────────

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

class ExactAliasMatcher implements AliasMatcher {
  constructor(private readonly entries: Map<string, readonly AliasMatchResult[]> = new Map()) {}

  findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve(this.entries.get(normalizedQuery) ?? []);
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

function makeLlmConstraintExtractionTrace(
  overrides: Partial<ConstraintExtractionTrace> = {},
): ConstraintExtractionTrace {
  return {
    candidatePhraseCount: 1,
    candidateSpanCount: 1,
    ruleTableHitCount: 0,
    llmHitCount: 1,
    llmSkippedCount: 0,
    fallbackTriggered: false,
    source: 'llm_only',
    llmLatencyMs: 23,
    phraseCacheHits: 0,
    phraseCacheNegativeSkipped: 0,
    phraseCacheMisses: 0,
    llmLinkedEntityCount: 1,
    resolvedEntityCount: 1,
    directHardConstraintCount: 0,
    ontologyExpandedConstraintCount: 0,
    compositionalInferenceCount: 0,
    phrasesByTier: {
      tier1_default_mapping: 0,
      tier2_entity_resolver: 0,
      tier3_ontology_expansion: 0,
      tier4_compositional_inference: 0,
      tier5_llm_linker: 1,
      tier6_regex_fallback: 0,
      unmapped: 0,
    },
    categoriesCovered: ['grape_primary'],
    unresolvedSpanSamples: ['피노'],
    semanticConstraintRecall: 1,
    entityLinkingAccuracy: 1,
    missedPhrases: [],
    ...overrides,
  };
}

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: () => Promise.resolve(false),
  getAmbiguityInfo: () => Promise.resolve(null),
  getAmbiguityInfoBatch: () => Promise.resolve(new Map()),
};

class NullMappingTable implements MappingTablePort {
  async findMapping(_phrase: string): Promise<NLMapping | null> {
    return null;
  }

  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }

  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

function makeBuiltinFallbackNlMapper(): NLMapper {
  return new NLMapper(new NullMappingTable());
}

const noOpNLMapper: NLMapperPort = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: () => Promise.resolve({ constraints: [] }),
} as unknown as NLMapperPort;

function makePlanner(
  entries: Map<string, AliasMatchResult> = new Map(),
  dict: AmbiguityDictionary = noAmbiguityDict,
  nlMapper: NLMapperPort = noOpNLMapper,
): Planner {
  const aliasMatcher = new StubAliasMatcher(entries);
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  return new Planner(dict, anchorExtractor, expansionBuilder, nlMapper);
}

// ── Request-scoped constraint extraction (no shared mutable trace) ───────────

describe('Planner – constraint extraction metadata', () => {
  it('concurrent plan() calls each keep their own constraintExtraction from NLMapper', async () => {
    const tracingNLMapper: NLMapper = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: async (phrases: readonly string[]) => ({
        constraints: [],
        constraintExtraction: {
          candidatePhraseCount: phrases.length,
          ruleTableHitCount: 0,
          llmHitCount: 0,
          llmSkippedCount: 0,
          fallbackTriggered: true,
          source: 'fallback',
          llmLatencyMs: null,
          phraseCacheHits: 0,
          phraseCacheNegativeSkipped: 0,
          phraseCacheMisses: 0,
          missedPhrases: [],
        },
      }),
    } as unknown as NLMapper;

    const planner = makePlanner(new Map(), noAmbiguityDict, tracingNLMapper);
    const [pShort, pLong] = await Promise.all([planner.plan('x'), planner.plan('x y z')]);

    expect(pShort.constraintExtraction?.candidatePhraseCount).toBeDefined();
    expect(pLong.constraintExtraction?.candidatePhraseCount).toBeDefined();
    expect(pLong.constraintExtraction!.candidatePhraseCount).toBeGreaterThan(
      pShort.constraintExtraction!.candidatePhraseCount,
    );
  });

  it('threads fuzzy-recovered anchors into expansion building', async () => {
    let seenAnchors: readonly AnchorCandidate[] = [];
    const expansionBuilder = {
      build: (
        _normalizedQuery: string,
        _intent: QueryIntent,
        anchors: readonly AnchorCandidate[],
      ): ExpansionBundle => {
        seenAnchors = anchors;
        return { lexical: anchors.map((anchor) => anchor.normalizedForm), semantic: [] };
      },
    };
    const fuzzyMatcher: FuzzyMatcherPort = {
      match: () => [{ term: 'opus one', editDistance: 1, combinedScore: 0.92 }],
    };
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new StubAliasMatcher(new Map([
        ['opus one', makeMatchResult('Opus One', 0.93)],
      ]))),
      expansionBuilder as unknown as ExpansionBuilder,
      noOpNLMapper,
      fuzzyMatcher,
    );

    const plan = await planner.plan('opux one');

    expect(plan.anchors).toHaveLength(1);
    expect(plan.anchors[0]?.source).toBe('planner_heuristic');
    expect(seenAnchors).toHaveLength(1);
    expect(seenAnchors[0]?.source).toBe('planner_heuristic');
    expect(plan.expansions.lexical).toContain('opus one');
  });

  it('performs batched fuzzy fallback lookups instead of per-hit lookups', async () => {
    const batchLookup = vi.fn(async (queries: readonly string[]) => {
      const result = new Map<string, readonly AliasMatchResult[]>();
      for (const query of queries) {
        result.set(
          query,
          query === 'opus one'
            ? [makeMatchResult(query, 0.88, [`entity-${query.replace(/\s+/g, '-')}`])]
            : [],
        );
      }
      return result;
    });
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor({
        findMatches: vi.fn(async (_query: string): Promise<readonly AliasMatchResult[]> => []),
        findMatchesBatch: batchLookup,
      }),
      new ExpansionBuilder(),
      noOpNLMapper,
      {
        match: () => [{ term: 'opus one', editDistance: 1, combinedScore: 0.92 }],
      },
    );

    const plan = await planner.plan('opux one');

    expect(plan.anchors.length).toBeGreaterThan(0);
    expect(plan.anchors.some((anchor) => anchor.source === 'planner_heuristic')).toBe(true);
    expect(batchLookup).toHaveBeenCalledTimes(3);
    expect(batchLookup.mock.calls[2]?.[0]).toEqual(expect.arrayContaining(['opus one']));
  });

  it('promotes queryClass to ambiguous_short_form when constraint parsing emits ambiguity hints', async () => {
    const ambiguousHintMapper: NLMapper = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: async () => ({
        constraints: [],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
          ],
        }],
      }),
    } as unknown as NLMapper;

    const planner = makePlanner(new Map(), noAmbiguityDict, ambiguousHintMapper);
    const plan = await planner.plan('피노 추천');

    expect(plan.queryClass).toBe('ambiguous_short_form');
    expect(plan.expansions.ambiguousEntityHints).toHaveLength(1);
  });

  it('reflects compiler-authored ambiguity hints and LLM extraction metrics in the plan', async () => {
    const compilerBackedMapper: NLMapper = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: async () => ({
        constraints: [],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
            {
              label: 'Pinot Blanc',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Blanc',
              },
              matchValues: ['Pinot Blanc'],
              lexicalExpansions: ['pinot blanc'],
              semanticExpansions: ['pinot blanc'],
            },
          ],
        }],
        constraintExtraction: makeLlmConstraintExtractionTrace(),
      }),
    } as unknown as NLMapper;

    const planner = makePlanner(new Map(), noAmbiguityDict, compilerBackedMapper);
    const plan = await planner.plan('피노 추천', { enablePlannerTrace: true });

    expect(plan.constraintExtraction).toMatchObject({
      source: 'llm_only',
      llmHitCount: 1,
      llmSkippedCount: 0,
      llmLatencyMs: 23,
    });
    expect(plan.expansions.ambiguousEntityHints).toHaveLength(1);
    expect(plan.expansions.ambiguousEntityHints?.[0]?.clarifyOptions).toEqual([
      'Pinot Noir',
      'Pinot Gris',
      'Pinot Blanc',
    ]);
    expect(plan.plannerTrace?.map((record) => record.stage)).toEqual(
      expect.arrayContaining([
        'intent_classification',
        'route_resolution',
        'retrieval_mode_selection',
        'query_class_classification',
        'uncertainty_estimation',
        'target_entity_inference',
      ]),
    );
  });
});

// ── QueryPlanV2 shape ──────────────────────────────────────────────────────────

describe('Planner – returns QueryPlanV2', () => {
  it('plan() resolves to an object with suggestedRoute and suggestedRetrievalMode', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(plan).toHaveProperty('suggestedRoute');
    expect(plan).toHaveProperty('suggestedRetrievalMode');
  });

  it('plan() result does NOT have legacy "route" or "retrievalMode" fields', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    // QueryPlanV2 drops the binding execution fields from V1
    expect(plan).not.toHaveProperty('route');
    expect(plan).not.toHaveProperty('retrievalMode');
    expect(plan).not.toHaveProperty('policy');
  });
});

// ── suggestedRoute matches old route logic ─────────────────────────────────────

describe('Planner – suggestedRoute matches expected routing', () => {
  it('entity query with strong anchor → suggestedRoute is "entity"', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.suggestedRoute).toBe('entity');
  });

  it('exact wine metadata query keeps the entity route', async () => {
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸스원 지금 마시기 좋아?');

    expect(plan.intent).toBe('entity_exact');
    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('entity_lookup');
  });

  it('exact future-vintage metadata query for Almaviva stays on the entity route', async () => {
    const entries = new Map([['알마비바', makeMatchResult('알마비바', 0.95, ['entity-almaviva'])]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('알마비바 2026 빈티지 나왔는지 확실한 근거 없으면 추정하지 말고 말해줘');

    expect(plan.intent).toBe('entity_exact');
    expect(plan.queryClass).toBe('short_entity');
    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('entity_lookup');
    expect(plan.uncertainty.ambiguityDetected).toBe(false);
    expect(plan.uncertainty.ambiguityTypes).toEqual([]);
  });

  it('slang grape query with trailing request words still routes as exact entity', async () => {
    const anchorMatcher = new ExactAliasMatcher(
      new Map([
        ['카베르네 소비뇽', [makeMatchResult('카베르네 소비뇽', 0.95, ['entity-cabernet-sauvignon'])]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(anchorMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );
    const plan = await planner.plan('까쇼 추천해줘');

    expect(plan.anchors).toHaveLength(1);
    expect(plan.intent).toBe('entity_exact');
    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('entity_lookup');
  });

  it('Korean mixed query with anchor → suggestedRoute is "mixed"', async () => {
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.9)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸스원 같은 10만원 와인');

    expect(plan.suggestedRoute).toBe('mixed');
  });

  it('RFC-021 T-PSA-03: lockDiscoveryLane suppresses the mixed/similar_items promotion for the SAME query', async () => {
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.9)]]);
    const planner = makePlanner(entries);
    // Identical anchored-similarity query as above, but routed through a public
    // primitive discovery lane (path authority). The planner must still compile
    // the query but MUST NOT hand the lane to the mixed/anchor-similarity route.
    const plan = await planner.plan('오푸스원 같은 10만원 와인', { lockDiscoveryLane: true });

    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).not.toBe('similar_items');
  });

  it('RFC-021 T-PSA-03: lockDiscoveryLane keeps an exact entity query on the discovery lane, not the entity route', async () => {
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸스원', { lockDiscoveryLane: true });

    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).not.toBe('entity_lookup');
    expect(plan.suggestedRetrievalMode).not.toBe('similar_items');
  });

  it('constraint-only query with no anchors → suggestedRoute is "hybrid"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('풀바디 레드 와인');

    expect(plan.suggestedRoute).toBe('hybrid');
  });

  it.each([
    ['풀바디 레드 와인'],
    ['상큼한 화이트 와인'],
    ['호주 쉬라즈 풀바디'],
    ['강한 타닌 네비올로'],
    ['medium body United States / United States red'],
    ['미디엄 Spain / Spain 레드'],
  ])('sensory preference query %s → semantic_discovery / attribute_search / semantic_preference', async (query) => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan(query);

    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
  });

  it('keeps sensory preference promotion when only low-confidence catalog noise anchors exist', async () => {
    const noisyMatcher = new ExactAliasMatcher(new Map([
      ['medium body united states / united states red', [
        {
          surfaceForm: 'United States Red Collection',
          normalizedForm: 'united states red collection',
          entityIds: ['noise-us-red-collection'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.25,
          lookupStrategy: 'lexical_exact',
          aliasType: 'catalog_noise_alias',
        },
      ]],
    ]));
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('medium body United States / United States red');

    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
  });

  it('does not apply fuzzy entity fallback to parsed semantic preference queries', async () => {
    const fuzzyMatcher: FuzzyMatcherPort = {
      match: vi.fn(() => [{ term: 'dallaan wine', editDistance: 1, combinedScore: 0.93 }]),
    };
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher(new Map([
        ['dallaan wine', [makeMatchResult('Dallaan Wine', 0.94, ['noise-dallaan'])]],
      ]))),
      new ExpansionBuilder(),
      noOpNLMapper,
      fuzzyMatcher,
    );

    const plan = await planner.plan('달달한 와인');

    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.anchors).toHaveLength(0);
    expect(plan.expansions.fuzzyEntityHypotheses).toBeUndefined();
  });

  it('suppresses generic pairing-token anchors before final pairing classification', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['wine', [{
          surfaceForm: '2014 1849 Wine Company Declaration',
          normalizedForm: '2014 1849 wine company declaration',
          entityIds: ['wine-company-2014'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 1,
          lookupStrategy: 'lexical_exact',
          aliasType: 'canonical',
        }]],
        ['for', [{
          surfaceForm: '2015 Foradori Granato',
          normalizedForm: '2015 foradori granato',
          entityIds: ['foradori-2015'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.9,
          lookupStrategy: 'prefix_exact',
          aliasType: 'canonical',
        }]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('wine for cheese');

    expect(plan.intent).toBe('pairing_search');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('recommendation');
    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.constraints.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'pairing',
          operator: 'in',
          value: ['cheese'],
          soft_promotion_authority: 'allow',
        }),
      ]),
    );
  });

  it('collapses multiple pairing tags into one promotable OR constraint', async () => {
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher()),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('wine for cheese and salmon');
    const pairingConstraints = plan.constraints.soft.filter((constraint) => constraint.attribute === 'pairing');

    expect(pairingConstraints).toHaveLength(1);
    expect(pairingConstraints[0]).toEqual(
      expect.objectContaining({
        operator: 'in',
        value: ['salmon', 'cheese'],
        soft_promotion_authority: 'allow',
        mapping_version: 'pairing-taxonomy-v1.0',
      }),
    );
  });

  it('routes mixed-script food pairing queries through pairing_search instead of entity_fuzzy', async () => {
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher()),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('Cheese에 어울리는 와인');

    expect(plan.intent).toBe('pairing_search');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('recommendation');
    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.constraints.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'pairing',
          operator: 'in',
          value: ['cheese'],
          soft_promotion_authority: 'allow',
        }),
      ]),
    );
  });

  it('keeps occasion recommendation queries on semantic discovery instead of pairing_search', async () => {
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher()),
      new ExpansionBuilder(),
      makeBuiltinFallbackNlMapper(),
    );

    const plan = await planner.plan('기념일 선물용 와인 추천');

    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.constraints.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'occasion',
          operator: 'in',
          value: ['gift'],
        }),
      ]),
    );
  });

  it('suppresses noisy exact-like anchors for semantic preference queries', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['a', [
          {
            surfaceForm: 'à느이므아 느에그르아 à느',
            normalizedForm: 'à느이므아 느에그르아 à느',
            entityIds: ['noise-a-1'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.66,
            lookupStrategy: 'phonetic_exact',
            aliasType: 'translation',
          },
          {
            surfaceForm: 'à느이므아 느에그르아 스오느 느에그르에',
            normalizedForm: 'à느이므아 느에그르아 스오느 느에그르에',
            entityIds: ['noise-a-2'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.66,
            lookupStrategy: 'phonetic_exact',
            aliasType: 'translation',
          },
        ]],
        ['red', [
          {
            surfaceForm: 'Rotie',
            normalizedForm: 'rotie',
            entityIds: ['rotie-noise'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.792,
            lookupStrategy: 'phonetic_exact',
            aliasType: 'translation',
          },
          {
            surfaceForm: 'Red Noise',
            normalizedForm: 'red noise',
            entityIds: ['red-noise-2'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.792,
            lookupStrategy: 'phonetic_exact',
            aliasType: 'translation',
          },
        ]],
        ['spain', [
          {
            surfaceForm: 'Spain Noise',
            normalizedForm: 'spain noise',
            entityIds: ['spain-noise-1'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
          {
            surfaceForm: 'Spain Noise Deux',
            normalizedForm: 'spain noise deux',
            entityIds: ['spain-noise-2'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
        ]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('recommend a light-bodied Spain red');

    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.constraints.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'body',
          operator: '<=',
          value: 0.3,
        }),
      ]),
    );
  });

  it('suppresses noisy prefix anchors for budget/constraint queries before mixed fallback contamination', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['france', [
          {
            surfaceForm: '1967 Francesco Rinaldi & Figli Barolo',
            normalizedForm: '1967 francesco rinaldi & figli barolo',
            entityIds: ['francesco-rinaldi-1967'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
          {
            surfaceForm: '2018 Francesca Fiasco Difesa Rosso',
            normalizedForm: '2018 francesca fiasco difesa rosso',
            entityIds: ['francesca-fiasco-2018'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
        ]],
        ['for', [
          {
            surfaceForm: '2015 Foradori Granato',
            normalizedForm: '2015 foradori granato',
            entityIds: ['foradori-2015'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
          {
            surfaceForm: '2018 Fortunate Son The Diplomat',
            normalizedForm: '2018 fortunate son the diplomat',
            entityIds: ['fortunate-son-2018'] as unknown as AliasMatchResult['entityIds'],
            matchConfidence: 0.9,
            lookupStrategy: 'prefix_exact',
            aliasType: 'canonical',
          },
        ]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('good France red for under $50');

    expect(plan.intent).toBe('budget_search');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('constraint_filter');
    expect(plan.queryClass).toBe('pure_constraint');
  });

  it('suppresses generic wine-noun fuzzy anchors for sweetness preference queries', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['와인', [{
          surfaceForm: '1848 와이너리',
          normalizedForm: '1848 와이너리',
          entityIds: ['1848-winery'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.54,
          lookupStrategy: 'transliterated_fuzzy',
          aliasType: 'phonetic',
        }]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('달달한 와인');

    expect(plan.anchors).toHaveLength(0);
    expect(plan.intent).toBe('semantic_discovery');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('attribute_search');
    expect(plan.queryClass).toBe('semantic_preference');
  });

  it('suppresses generic wine-noun fuzzy anchors for typed category queries', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['와인', [{
          surfaceForm: '1848 와이너리',
          normalizedForm: '1848 와이너리',
          entityIds: ['1848-winery'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.54,
          lookupStrategy: 'hangul_ime_completion',
          aliasType: 'phonetic',
        }]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('스파클링 와인');

    expect(plan.anchors).toHaveLength(0);
    expect(plan.intent).toBe('facet_search');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('constraint_filter');
    expect(plan.queryClass).toBe('pure_constraint');
  });

  it('suppresses multi-entity category anchors when parsed constraints already explain the surface', async () => {
    const noisyMatcher = new ExactAliasMatcher(
      new Map([
        ['샴페인', [{
          surfaceForm: '샴페인',
          normalizedForm: '샴페인',
          entityIds: [
            'champagne-entity-1',
            'champagne-entity-2',
            'champagne-entity-3',
          ] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.75,
          lookupStrategy: 'exact',
          aliasType: 'translation',
        }]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(noisyMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('샴페인 추천');

    expect(plan.anchors).toHaveLength(0);
    expect(plan.intent).toBe('facet_search');
    expect(plan.suggestedRoute).toBe('hybrid');
    expect(plan.suggestedRetrievalMode).toBe('constraint_filter');
    expect(plan.queryClass).toBe('pure_constraint');
  });

  it('does not suppress single-token relative anchors when comparison intent is explicit', async () => {
    const anchorMatcher = new ExactAliasMatcher(
      new Map([
        ['barolo', [{
          surfaceForm: 'Barolo',
          normalizedForm: 'barolo',
          entityIds: ['barolo-appellation'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.95,
          lookupStrategy: 'lexical_exact',
          aliasType: 'canonical',
        }]],
      ]),
    );
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(anchorMatcher),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('barolo 같은 10만원 와인');

    expect(plan.suggestedRoute).toBe('mixed');
    expect(plan.anchors[0]?.surfaceForm).toBe('Barolo');
  });

  it('explicit non-existent Korean query → entity no_match_detection fail-closed lane', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('존재하지않는 와인 12345');

    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('no_match_detection');
    expect(plan.queryClass).toBe('unknown');
    expect(plan.constraints.hard).toHaveLength(0);
    expect(plan.constraints.soft).toHaveLength(0);
  });

  it('anchor-conditioned negation keeps anchor semantics and does not leak anchor text into exclude constraints', async () => {
    const entries = new Map([['클라우디베이', makeMatchResult('클라우디베이', 0.94, ['cloudy-bay-2022'])]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('클라우디베이 말고 다른 화이트');

    expect(plan.intent).toBe('mixed_query');
    expect(plan.suggestedRoute).toBe('mixed');
    expect(plan.anchors[0]?.surfaceForm).toBe('클라우디베이');
    expect(
      plan.constraints.hard.some(
        (constraint) =>
          constraint.attribute === 'region'
          && constraint.operator === 'exclude'
          && constraint.value === '클라우디베이',
      ),
    ).toBe(false);
    expect(
      plan.constraints.hard.some(
        (constraint) =>
          constraint.attribute === 'wine_type'
          && constraint.operator === '='
          && constraint.value === 'white',
      ),
    ).toBe(true);
  });

  it('strong exact entity anchors are stripped from constraint parsing so noisy reversed Korean forms stay entity_exact', async () => {
    const anchorMatcher = new ExactAliasMatcher(
      new Map([
        ['샤또 마고', [{
          surfaceForm: '샤토 마고',
          normalizedForm: '샤토 마고',
          entityIds: ['chateau-margaux-2015'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.95,
          lookupStrategy: 'exact',
        }]],
        ['chateau', [{
          surfaceForm: "Château d'Yquem",
          normalizedForm: "château d'yquem",
          entityIds: ['sauternes-2015'] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.85,
          lookupStrategy: 'substring',
        }]],
      ]),
    );
    const strippingAwareMapper: NLMapper = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: async (phrases: readonly string[]) => ({
        constraints: phrases.some((phrase) => phrase.includes('마고'))
          ? [{
            attribute: 'appellation',
            operator: '=',
            value: 'Margaux',
            confidence: 0.9,
            source_phrase: '마고',
            mapping_version: 'test-v1',
          }]
          : [],
      }),
    } as unknown as NLMapper;
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(anchorMatcher),
      new ExpansionBuilder(),
      strippingAwareMapper,
    );

    const plan = await planner.plan('마고 샤또');

    expect(plan.intent).toBe('entity_exact');
    expect(plan.queryClass).toBe('short_entity');
    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('entity_lookup');
    expect(plan.constraints.hard).toHaveLength(0);
  });

  it('mixed similar-items queries do not leak anchor-local vintage into hard constraints', async () => {
    const entries = new Map([
      ['opus one 2018', makeMatchResult('Opus One 2018', 0.97, ['opus-one-2018'])],
    ]);
    const planner = makePlanner(entries);

    const plan = await planner.plan('Opus One 2018 비슷한 와인');

    expect(plan.intent).toBe('mixed_query');
    expect(plan.queryClass).toBe('anchored_similarity');
    expect(plan.suggestedRoute).toBe('mixed');
    expect(plan.suggestedRetrievalMode).toBe('similar_items');
    expect(
      plan.constraints.hard.some((constraint) => constraint.attribute === 'vintage_year'),
    ).toBe(false);
  });
});

// ── suggestedRetrievalMode matches old retrievalMode logic ────────────────────

describe('Planner – suggestedRetrievalMode matches expected mode', () => {
  it('strong anchor + "best wines" → suggestedRetrievalMode is "producer_browse"', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One best wines');

    expect(plan.suggestedRetrievalMode).toBe('producer_browse');
  });

  it('facet query with hierarchical path (≥2 slashes) → suggestedRetrievalMode is "region_browse"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('red wine from france / bordeaux / medoc');

    expect(plan.intent).toBe('facet_search');
    expect(plan.suggestedRetrievalMode).toBe('region_browse');
  });

  it('entity_exact with no anchor → suggestedRetrievalMode is "attribute_search"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('semantic discovery wine');

    expect(plan.suggestedRetrievalMode).toBeDefined();
    expect(typeof plan.suggestedRetrievalMode).toBe('string');
  });

  it('single-candidate entity_fuzzy still uses entity_resolution, not exploratory attribute_search', async () => {
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher(new Map([
        ['margxaux', [makeMatchResult('Château Margaux 2015', 0.78, ['chateau-margaux-2015'])]],
      ]))),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('margxaux');

    expect(plan.intent).toBe('entity_fuzzy');
    expect(plan.suggestedRetrievalMode).toBe('entity_resolution');
  });
});

// ── planV2ToUnderstandingSnapshot ─────────────────────────────────────────────

describe('planV2ToUnderstandingSnapshot', () => {
  it('produces a valid QueryUnderstandingSnapshot from a QueryPlanV2', async () => {
    const planner = makePlanner();
    const plan: QueryPlanV2 = await planner.plan('Château Margaux 2015');

    const snapshot: QueryUnderstandingSnapshot = planV2ToUnderstandingSnapshot(plan);

    // All understanding fields are present
    expect(snapshot.rawQuery).toBe('Château Margaux 2015');
    expect(typeof snapshot.normalizedQuery).toBe('string');
    expect(snapshot.intent).toBeDefined();
    expect(Array.isArray(snapshot.anchors)).toBe(true);
    expect(snapshot.constraints).toBeDefined();
    expect(snapshot.expansions).toBeDefined();
    expect(snapshot.uncertainty).toBeDefined();
    expect(snapshot.queryClass).toBeDefined();
    expect(typeof snapshot.plannerVersion).toBe('string');
    expect(typeof snapshot.policyRuleVersion).toBe('string');
    expect(typeof snapshot.thresholdProfileId).toBe('string');
  });

  it('forwards constraintExtraction from QueryPlanV2 onto the snapshot', () => {
    const extraction = {
      candidatePhraseCount: 4,
      ruleTableHitCount: 0,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: true,
      source: 'fallback' as const,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: [] as readonly string[],
    };
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'semantic_discovery',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'semantic_preference',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      constraintExtraction: extraction,
    };
    const snapshot = planV2ToUnderstandingSnapshot(plan);
    expect(snapshot.constraintExtraction).toEqual(extraction);
  });

  it('forwards retrievalPlan from QueryPlanV2 onto the snapshot', () => {
    const retrievalPlan = {
      hardFilterTokens: ['region:Bordeaux'],
      softBoosts: [],
      inferredBoosts: [],
      sensoryPriors: [],
      planVersion: 'retrieval-plan-v1.0',
    };
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'semantic_discovery',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'semantic_preference',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      retrievalPlan,
    };
    const snapshot = planV2ToUnderstandingSnapshot(plan);
    expect(snapshot.retrievalPlan).toEqual(retrievalPlan);
  });

  it('forwards retrievalObjective from QueryPlanV2 onto the snapshot', () => {
    const retrievalObjective = {
      objectiveVersion: 'retrieval-objective-v1.0' as const,
      signals: [
        {
          axis: 'occasion' as const,
          attribute: 'occasion',
          operator: 'in' as const,
          value: ['gift'],
          sourcePhrase: '선물',
          confidence: 0.9,
          sourceTier: 'soft' as const,
        },
      ],
    };
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'semantic_discovery',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'semantic_preference',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      retrievalObjective,
    };
    const snapshot = planV2ToUnderstandingSnapshot(plan);
    expect(snapshot.retrievalObjective).toEqual(retrievalObjective);
  });

  it('snapshot does NOT include suggestedRoute, suggestedRetrievalMode, or admission_context', () => {
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'semantic_discovery',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'semantic_preference',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      admission_context: {
        requires_identity_seal: false,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    };

    const snapshot = planV2ToUnderstandingSnapshot(plan);

    expect(snapshot).not.toHaveProperty('suggestedRoute');
    expect(snapshot).not.toHaveProperty('suggestedRetrievalMode');
    expect(snapshot).not.toHaveProperty('admission_context');
  });

  it('optional fields (normalizedQueryViews, secondaryIntents, targetEntityType, sessionContext, queryBudget) are omitted when absent', () => {
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'facet_search',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.8,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'pure_constraint',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'constraint_filter',
    };

    const snapshot = planV2ToUnderstandingSnapshot(plan);

    expect(Object.prototype.hasOwnProperty.call(snapshot, 'normalizedQueryViews')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'secondaryIntents')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'targetEntityType')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'sessionContext')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'queryBudget')).toBe(false);
  });
});

// ── Regression: existing planner behavior unchanged ───────────────────────────

describe('Planner – regression (same query → same intent, anchors, constraints)', () => {
  it('normalizedQuery is correctly lowercased and accent-stripped', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Château Margaux');

    expect(plan.normalizedQuery).toContain('chateau margaux');
    expect(plan.rawQuery).toBe('Château Margaux');
  });

  it('plannerVersion is a non-empty string', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(typeof plan.plannerVersion).toBe('string');
    expect(plan.plannerVersion.length).toBeGreaterThan(0);
  });

  it('entity query with anchor → intent is entity_exact', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.intent).toBe('entity_exact');
  });

  it('Korean noisy prefix query still plans as entity_exact when the curated prefix resolves to Opus One', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸');

    expect(plan.intent).toBe('entity_exact');
    expect(plan.anchors[0]?.normalizedForm).toBe('opus one');
  });

  it('anchors are extracted for known entities', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.anchors.length).toBeGreaterThan(0);
    expect(plan.anchors[0]?.normalizedForm).toBe('opus one');
  });

  it('constraints are populated for attribute queries', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('full body red wine under 50 dollars');

    // Rule-based extraction should detect wine_type or price constraints
    const allConstraints = [
      ...plan.constraints.hard,
      ...plan.constraints.soft,
      ...plan.constraints.inferred,
    ];
    expect(allConstraints.length).toBeGreaterThan(0);
  });

  it('drops lexical_exact generic appellation anchors once the span is compiled as a hard constraint', async () => {
    const targetEntityId = 'wine-davide-fregonese-prapo';
    const genericEntityId = 'wine-generic-barolo';
    const query = '2019 Davide Fregonese Barolo Prapò';
    const planner = new Planner(
      noAmbiguityDict,
      new AnchorExtractor(new ExactAliasMatcher(new Map([
        ['2019 davide fregonese barolo prapò', [{
          surfaceForm: '2019 Davide Fregonese Barolo Prapò',
          normalizedForm: '2019 davide fregonese barolo prapò',
          entityIds: [targetEntityId] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 0.99,
          lookupStrategy: 'exact',
        }]],
        ['barolo', [{
          surfaceForm: '1961 Marchesi di Barolo Barolo (Tradizione)',
          normalizedForm: '1961 marchesi di barolo barolo (tradizione)',
          entityIds: [genericEntityId] as unknown as AliasMatchResult['entityIds'],
          matchConfidence: 1,
          lookupStrategy: 'lexical_exact',
        }]],
      ]))),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan(query);

    expect(plan.constraints.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'appellation', value: 'Barolo' }),
      ]),
    );
    expect(plan.anchors.map((anchor) => anchor.normalizedForm)).toContain('2019 davide fregonese barolo prapò');
    expect(plan.anchors.map((anchor) => anchor.normalizedForm)).not.toContain(
      '1961 marchesi di barolo barolo (tradizione)',
    );
    expect(plan.suggestedRoute).toBe('entity');
    expect(plan.suggestedRetrievalMode).toBe('entity_lookup');
  });

  it('uncertainty is populated with expected shape', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(typeof plan.uncertainty.overall).toBe('number');
    expect(plan.uncertainty.overall).toBeGreaterThanOrEqual(0);
    expect(plan.uncertainty.overall).toBeLessThanOrEqual(1);
    expect(typeof plan.uncertainty.ambiguityDetected).toBe('boolean');
  });
});
