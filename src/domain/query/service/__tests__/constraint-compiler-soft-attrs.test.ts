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

const SOFT_ATTRS_UNDER_TEST = [
  { attribute: 'price_band', value: 'mid' },
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
});
