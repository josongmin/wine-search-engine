/**
 * W2-01: SOFT_CONSTRAINT_ATTRIBUTES classification tests.
 *
 * These 5 attributes must be classified as SOFT (not hard YQL filters)
 * to prevent 0-result queries when users express preferences.
 *
 * The SOFT_CONSTRAINT_ATTRIBUTES set is module-private in constraint-compiler.ts,
 * so we test via the NLMapper-free path: the entity-resolver classification.
 * We drive the compiler with a mock NLMapper that returns constraints for each
 * attribute, then verify they land in bundle.soft, not bundle.hard.
 */

import { describe, it, expect } from 'vitest';
import { ConstraintCompiler } from '../constraint-compiler.js';
import type { NLMapper } from '../../../attribute/service/nl-mapper.js';
import { NLMapper as DefaultNLMapper } from '../../../attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../../attribute/port/mapping-table.port.js';

/** Minimal NLMapper stub that returns a single constraint for the given attribute. */
function makeNLMapper(attribute: string, value: string): NLMapper {
  return {
    mapConstraints: async () => ({
      constraints: [
        {
          attribute,
          operator: '=' as const,
          value,
          source_phrase: attribute,
          confidence: 0.9,
          mapping_version: 'test-v1.0',
        },
      ],
      constraintExtraction: {
        candidatePhraseCount: 1,
        candidateSpanCount: 1,
        ruleTableHitCount: 1,
        llmHitCount: 0,
        llmSkippedCount: 0,
        fallbackTriggered: false,
        source: 'rule_table' as const,
        llmLatencyMs: null,
        phraseCacheHits: 0,
        phraseCacheNegativeSkipped: 0,
        phraseCacheMisses: 0,
        missedPhrases: [],
      },
    }),
  } as unknown as NLMapper;
}

class NullMappingTablePort implements MappingTablePort {
  async findMapping(): Promise<null> {
    return null;
  }
  async findMappingsByAttribute(): Promise<readonly []> {
    return [];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

const SOFT_ATTRS_UNDER_TEST = [
  { attribute: 'price_band', value: 'value' },
  { attribute: 'occasion', value: 'celebration' },
  { attribute: 'critic_score', value: '0.8' },
  { attribute: 'fruit_intensity', value: '0.7' },
  // 'finish' (bare) removed from SOFT_CONSTRAINT_ATTRIBUTES — only 'finish_length' maps to
  // HybridCandidate. Keeping the test only for finish_length below (SSoT coverage).
  // IDX-05: acidity must NOT generate a Vespa YQL hard filter (it causes 0-result queries).
  // This was the original BUG-15 root cause — acidity was in the hard path.
  { attribute: 'acidity', value: '0.6' },
  // Full SOFT_CONSTRAINT_ATTRIBUTES SSoT coverage
  { attribute: 'body', value: '0.8' },
  { attribute: 'sweetness', value: '0.2' },
  { attribute: 'tannin', value: '0.7' },
  { attribute: 'style', value: 'bold' },
  { attribute: 'producer_prestige', value: '0.9' },
  { attribute: 'finish_length', value: '0.8' },
  { attribute: 'drinking_window', value: '2024' },
  { attribute: 'flavor_profile', value: 'fruity' },
  { attribute: 'certification', value: 'organic' },
  { attribute: 'alcohol_pct', value: '12' },
] as const;

describe('W2-01 + IDX-05: all SOFT_CONSTRAINT_ATTRIBUTES must be SOFT in ConstraintCompiler', () => {
  for (const { attribute, value } of SOFT_ATTRS_UNDER_TEST) {
    it(`${attribute} → lands in bundle.soft, not bundle.hard`, async () => {
      const compiler = new ConstraintCompiler(makeNLMapper(attribute, value));
      const result = await compiler.compile('test query');

      const inSoft = result.bundle.soft.some((c) => c.attribute === attribute);
      const inHard = result.bundle.hard.some((c) => c.attribute === attribute);

      expect(inSoft).toBe(true);
      expect(inHard).toBe(false);
    });
  }

  it('style with not_in operator → lands in bundle.hard (negation is always hard)', async () => {
    // BUG-A regression: not_in produces NOT-clauses just like exclude.
    // Before fix: operator !== 'exclude' check passed not_in as soft.
    const mapper: NLMapper = {
      mapConstraints: async () => ({
        constraints: [
          {
            attribute: 'style',
            operator: 'not_in' as const,
            value: ['oaky', 'bold'],
            source_phrase: 'style',
            confidence: 0.9,
            mapping_version: 'test-v1.0',
          },
        ],
        constraintExtraction: {
          candidatePhraseCount: 1,
          candidateSpanCount: 1,
          ruleTableHitCount: 1,
          llmHitCount: 0,
          llmSkippedCount: 0,
          fallbackTriggered: false,
          source: 'rule_table' as const,
          llmLatencyMs: null,
          phraseCacheHits: 0,
          phraseCacheNegativeSkipped: 0,
          phraseCacheMisses: 0,
          missedPhrases: [],
        },
      }),
    } as unknown as NLMapper;
    const compiler = new ConstraintCompiler(mapper);
    const result = await compiler.compile('no oaky bold style');

    const inHard = result.bundle.hard.some((c) => c.attribute === 'style');
    const inSoft = result.bundle.soft.some((c) => c.attribute === 'style');
    expect(inHard).toBe(true);
    expect(inSoft).toBe(false);
  });

  it('price_band with not_in operator → lands in bundle.hard (negation is always hard)', async () => {
    const mapper: NLMapper = {
      mapConstraints: async () => ({
        constraints: [
          {
            attribute: 'price_band',
            operator: 'not_in' as const,
            value: ['luxury', 'premium'],
            source_phrase: 'price_band',
            confidence: 0.9,
            mapping_version: 'test-v1.0',
          },
        ],
        constraintExtraction: {
          candidatePhraseCount: 1,
          candidateSpanCount: 1,
          ruleTableHitCount: 1,
          llmHitCount: 0,
          llmSkippedCount: 0,
          fallbackTriggered: false,
          source: 'rule_table' as const,
          llmLatencyMs: null,
          phraseCacheHits: 0,
          phraseCacheNegativeSkipped: 0,
          phraseCacheMisses: 0,
          missedPhrases: [],
        },
      }),
    } as unknown as NLMapper;
    const compiler = new ConstraintCompiler(mapper);
    const result = await compiler.compile('not luxury not premium');

    const inHard = result.bundle.hard.some((c) => c.attribute === 'price_band');
    const inSoft = result.bundle.soft.some((c) => c.attribute === 'price_band');
    expect(inHard).toBe(true);
    expect(inSoft).toBe(false);
  });

  it('wine_type → lands in bundle.hard (regression: must remain hard)', async () => {
    const compiler = new ConstraintCompiler(makeNLMapper('wine_type', 'red'));
    const result = await compiler.compile('test query');

    const inHard = result.bundle.hard.some((c) => c.attribute === 'wine_type');
    expect(inHard).toBe(true);
  });

  it('vintage_year → lands in bundle.hard (regression: vintage is an identity constraint)', async () => {
    const compiler = new ConstraintCompiler(makeNLMapper('vintage_year', '2018'));
    const result = await compiler.compile('test query');

    const inHard = result.bundle.hard.some((c) => c.attribute === 'vintage_year');
    expect(inHard).toBe(true);
  });

  it('NLMapper failure aborts compile instead of silently degrading to rule-only parsing', async () => {
    const nlMapper: NLMapper = {
      mapConstraints: async () => {
        throw new Error('mapper exploded');
      },
    } as unknown as NLMapper;
    const compiler = new ConstraintCompiler(nlMapper);

    await expect(compiler.compile('test query')).rejects.toThrow('mapper exploded');
  });

  it('propagates AbortError instead of masking cancellation as nlmapper_exception fallback', async () => {
    const nlMapper: NLMapper = {
      mapConstraints: async () => {
        const error = new Error('Constraint mapping aborted');
        error.name = 'AbortError';
        throw error;
      },
    } as unknown as NLMapper;
    const compiler = new ConstraintCompiler(nlMapper);

    await expect(compiler.compile('test query')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('real NLMapper extracts gift occasion from inflected Korean phrase', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['gift'] }),
      ]),
    );
  });

  it('real NLMapper extracts healing occasion from adjectival Korean phrase', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('힐링되는 와인 한 잔');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['healing'] }),
      ]),
    );
  });

  it('real NLMapper grounds 피노 그리지오 as Pinot Gris instead of leaking 피노 -> Pinot Noir', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('피노 그리지오 추천');

    expect(result.bundle.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'grape_primary', value: 'Pinot Gris' }),
      ]),
    );
    expect(result.bundle.hard).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'grape_primary', value: 'Pinot Noir' }),
      ]),
    );
  });

  it('ambiguous short alias 피노 does not promote to a grape constraint without disambiguating context', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('피노 추천');

    expect(result.bundle.soft).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'grape_primary' }),
      ]),
    );
    expect(result.bundle.hard).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'grape_primary' }),
      ]),
    );
  });

  it('exact wine aliases resolve for identity but do not become appellation hard constraints', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('샤또 마고');

    expect(result.resolvedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'appellation', canonicalValue: 'Château Margaux' }),
      ]),
    );
    expect(result.bundle.hard).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'appellation', value: 'Château Margaux' }),
      ]),
    );
    expect(result.constraintExtraction?.directHardConstraintCount).toBe(0);
  });

  it('exact wine alias shields overlapping bare appellation subspans', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('샤또 마고 보르도');

    expect(result.resolvedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'appellation', canonicalValue: 'Château Margaux' }),
      ]),
    );
    expect(result.bundle.hard).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'appellation', value: 'Margaux' }),
      ]),
    );
    expect(result.bundle.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', value: 'Bordeaux' }),
      ]),
    );
  });

  it('ontology appellations still become appellation hard constraints', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('바롤로 추천');

    expect(result.bundle.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'appellation', value: 'Barolo' }),
      ]),
    );
  });

  it('real NLMapper extracts date occasion and affordability from situational Korean phrasing', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('이번 주말 소개팅인데, 분위기 좋은 와인 추천. 너무 비싸면 부담스럽고');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['date_night'] }),
        expect.objectContaining({ attribute: 'price_band', value: 'value' }),
      ]),
    );
    expect(result.bundle.soft).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'price_band', value: 'luxury' }),
      ]),
    );
  });

  it('real NLMapper extracts camping + screw-cap + chillable constraints', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['camping'] }),
        expect.objectContaining({ attribute: 'closure', value: 'screw cap' }),
        expect.objectContaining({ attribute: 'style', value: ['chillable'] }),
      ]),
    );
  });

  it('real NLMapper extracts gift + approachable + crowd-pleasing constraints for non-expert gift query', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['gift'] }),
        expect.objectContaining({ attribute: 'style', value: ['approachable'] }),
        expect.objectContaining({ attribute: 'style', value: ['crowd_pleasing'] }),
      ]),
    );
  });

  it('real NLMapper extracts approachable and beginner constraints for first-time parents query', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('와인 처음 마시는 부모님께 추천할 와인');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'style', value: ['approachable'] }),
        expect.objectContaining({ attribute: 'beginner_suitability', operator: '>=', value: 0.5 }),
      ]),
    );
  });

  it('real NLMapper extracts presentation-forward style for pretty-label gift query', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('와인 입문자 선물용, 예쁜 라벨이면 좋겠다');
    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'style', value: ['presentation_forward'] }),
      ]),
    );
  });

  it('real NLMapper extracts gift + approachable + crowd-pleasing constraints for english gift query', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('gift for wine beginner, safe crowd-pleasing options');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', value: ['gift'] }),
        expect.objectContaining({ attribute: 'style', value: ['approachable'] }),
        expect.objectContaining({ attribute: 'style', value: ['crowd_pleasing'] }),
      ]),
    );
  });

  it('real NLMapper extracts low-alcohol soft constraint for beginner gift phrasing', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('와인 입문자 선물용, 달달하면서 도수 낮은 거');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'alcohol_pct', operator: '<=', value: 12 }),
      ]),
    );
    expect(result.bundle.hard).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'alcohol_pct' }),
      ]),
    );
  });

  it('keeps ambiguous short-form grape aliases as retrieval hints instead of direct constraints', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('피노 추천');

    expect(result.bundle.hard.some((constraint) => constraint.attribute === 'grape_primary')).toBe(false);
    expect(result.bundle.soft.some((constraint) => constraint.attribute === 'grape_primary')).toBe(false);
    expect(result.ambiguousEntityHints).toEqual([
      {
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
      },
    ]);
  });

  it('suppresses short-form Pinot ambiguity hints when a longer Pinot Grigio direct match already covers the span', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('피노 그리지오 추천');

    expect(result.ambiguousEntityHints).toEqual([]);
    expect(result.bundle.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'grape_primary',
          operator: '=',
          value: 'Pinot Gris',
        }),
      ]),
    );
  });

  it('infers off-dry or sweet style objective from spicy food pairing intent', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('매운 떡볶이랑 먹을 수 있는 와인 있어?');

    expect(result.bundle.inferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'style',
          operator: 'in',
          value: ['off_dry', 'sweet'],
        }),
      ]),
    );
  });

  it('infers white/sparkling/rosé objective from raw fish pairing intent', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('회 먹을 건데 와인 추천해줘');

    expect(result.bundle.inferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'wine_type',
          operator: 'in',
          value: ['white', 'sparkling', 'rosé'],
        }),
      ]),
    );
  });

  it('extracts explicit USD ceiling as max_price_krw through the compiler path', async () => {
    const compiler = new ConstraintCompiler(new DefaultNLMapper(new NullMappingTablePort()));
    const result = await compiler.compile('best Bordeaux under 100 dollars');

    expect(result.bundle.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'max_price_krw',
          operator: '<=',
          value: 135_000,
        }),
      ]),
    );
  });
});
