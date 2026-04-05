import { describe, it, expect } from 'vitest';
import { Planner } from '../../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../../src/domain/query/service/expansion-builder.js';
import { NLMapperNoOp } from '../../helpers/nl-mapper-noop.js';
import {
  InMemoryAmbiguityDictionary,
} from '../../integration/helpers/in-memory-adapters.js';
import type { AliasMatcher, AliasMatchResult } from '../../../src/domain/query/service/anchor-extractor.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

/**
 * Stub AliasMatcher for testing intent detection.
 */
class StubAliasMatcher implements AliasMatcher {
  private readonly entries: Map<string, AliasMatchResult>;

  constructor(entries: Map<string, AliasMatchResult> = new Map()) {
    this.entries = entries;
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const results: AliasMatchResult[] = [];
    for (const [surfaceKey, matchResult] of this.entries) {
      if (normalizedQuery.includes(surfaceKey.toLowerCase())) {
        results.push(matchResult);
      }
    }
    return results.sort((a, b) => b.matchConfidence - a.matchConfidence);
  }
}

function makeMatchResult(
  surfaceForm: string,
  confidence: number = 0.9,
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: [createEntityId()],
    matchConfidence: confidence,
  };
}

describe('Intent Detection — SOTA++ Improvements', () => {
  function createPlanner(aliasMatcher: AliasMatcher): Planner {
    const ambiguityDict = new InMemoryAmbiguityDictionary();
    const anchorExtractor = new AnchorExtractor(aliasMatcher);
    const expansionBuilder = new ExpansionBuilder();
    const nlMapper = new NLMapperNoOp();

    return new Planner(ambiguityDict, anchorExtractor, expansionBuilder, nlMapper);
  }

  describe('Strong anchor (≥0.85 confidence)', () => {
    it('should detect entity_exact for strong anchor without constraints', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.95)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one');
      expect(plan.intent).toBe('entity_exact');
    });

    it('should detect mixed_query for strong anchor + constraint keywords', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.95)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one red wine');
      expect(plan.intent).toBe('mixed_query');
    });

    it('should detect mixed_query for strong anchor + price keywords', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.90)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one under 50');
      expect(plan.intent).toBe('mixed_query');
    });
  });

  describe('Weak anchor (0.5-0.85 confidence) — SOTA++ improvement', () => {
    it('should detect entity_fuzzy for weak anchor without constraints', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['david arthur', makeMatchResult('David Arthur', 0.72)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('david arthur');
      expect(plan.intent).toBe('entity_fuzzy');
    });

    it('should detect mixed_query for weak anchor + constraint keywords', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['david arthur', makeMatchResult('David Arthur', 0.70)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('david arthur red wine');
      expect(plan.intent).toBe('mixed_query');
    });

    it('should detect mixed_query for weak anchor + price keywords', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['napa wine', makeMatchResult('Napa Wine', 0.65)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('napa wine under 30');
      expect(plan.intent).toBe('mixed_query');
    });
  });

  describe('Multiple anchors and comparison detection', () => {
    it('should detect comparison_search with explicit comparison marker + anchor', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.90)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one vs chateau margaux');
      expect(plan.intent).toBe('comparison_search');
    });

    it('should detect comparison_search with multiple anchors', async () => {
      const opusId = createEntityId();
      const margauxId = createEntityId();
      const matcher = new StubAliasMatcher(
        new Map([
          ['opus one', { ...makeMatchResult('Opus One', 0.90), entityIds: [opusId] }],
          ['margaux', { ...makeMatchResult('Château Margaux', 0.88), entityIds: [margauxId] }],
        ]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one compared to margaux');
      expect(plan.intent).toBe('comparison_search');
    });
  });

  describe('Korean mixed-query markers', () => {
    it('should detect mixed_query with "같은" (like/similar) + anchor', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['오푸스원', makeMatchResult('오푸스원', 0.92)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('오푸스원 같은 와인');
      expect(plan.intent).toBe('mixed_query');
    });

    it('should detect mixed_query with "비슷한" (similar to) + anchor', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['마고', makeMatchResult('마고', 0.90)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('마고 비슷한 와인');
      expect(plan.intent).toBe('mixed_query');
    });

    it('should detect mixed_query with "말고" (not/instead of) + anchor', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['오푸스원', makeMatchResult('오푸스원', 0.92)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('오푸스원 말고 다른 와인');
      expect(plan.intent).toBe('mixed_query');
    });
  });

  describe('Constraint keywords without anchors', () => {
    it('should detect facet_search for constraint keywords alone', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('red wine from bordeaux');
      expect(plan.intent).toBe('facet_search');
    });

    it('should detect budget_search for price keywords alone', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine under 50 dollars');
      expect(plan.intent).toBe('budget_search');
    });

    it('should detect facet_search for wine type keywords', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('sparkling wine from france');
      expect(plan.intent).toBe('facet_search');
    });
  });

  describe('Pairing detection', () => {
    it('should detect pairing_search for pairing keywords', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine that pairs with steak');
      expect(plan.intent).toBe('pairing_search');
    });

    it('should detect pairing_search for food pairing keywords', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine for seafood');
      expect(plan.intent).toBe('pairing_search');
    });

    it('should prefer pairing over semantic when pairing keywords present', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('red wine goes with cheese');
      expect(plan.intent).toBe('pairing_search');
    });
  });

  describe('Default semantic discovery', () => {
    it('should detect semantic_discovery for open-ended queries', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('what is a good wine');
      expect(plan.intent).toBe('semantic_discovery');
    });

    it('should detect semantic_discovery for vague wine preference queries', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('i like nice wines');
      expect(plan.intent).toBe('semantic_discovery');
    });

    it('should detect semantic_discovery with no anchors or keywords', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('recommend something nice');
      expect(plan.intent).toBe('semantic_discovery');
    });
  });

  describe('Intent routing to proper query class', () => {
    it('entity_exact should map to short_entity query class', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.95)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one');
      expect(plan.intent).toBe('entity_exact');
      expect(plan.queryClass).toBe('short_entity');
    });

    it('comparison_search should map to comparison_query class', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.90)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one vs margaux');
      expect(plan.intent).toBe('comparison_search');
      expect(plan.queryClass).toBe('comparison_query');
    });

    it('facet_search should map to pure_constraint query class', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('red wine from france');
      expect(plan.intent).toBe('facet_search');
      expect(plan.queryClass).toBe('pure_constraint');
    });

    it('semantic_discovery should map to semantic_preference query class', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('recommend a nice wine');
      expect(plan.intent).toBe('semantic_discovery');
      expect(plan.queryClass).toBe('semantic_preference');
    });
  });

  describe('Confidence threshold boundaries', () => {
    it('should treat 0.85 as exact anchor threshold', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['wine', makeMatchResult('Wine', 0.85)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine');
      expect(plan.intent).toBe('entity_exact');
    });

    it('should treat 0.84 as weak anchor', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['wine', makeMatchResult('Wine', 0.84)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine');
      expect(plan.intent).toBe('entity_fuzzy');
    });

    it('should treat 0.5 as minimum anchor presence threshold', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['wine', makeMatchResult('Wine', 0.50)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine cabernet');
      // With constraint keywords and weak anchor ≥0.5
      expect(['entity_fuzzy', 'mixed_query']).toContain(plan.intent);
    });

    it('should ignore anchors below 0.5 threshold', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['wine', makeMatchResult('Wine', 0.49)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('wine');
      // Below threshold = no anchor detected
      expect(plan.intent).toBe('semantic_discovery');
    });
  });

  describe('Edge cases and real-world queries', () => {
    it('should handle "David Arthur Cabernet 2014"', async () => {
      const matcher = new StubAliasMatcher(
        new Map([
          ['david arthur', makeMatchResult('David Arthur', 0.72)],
          ['cabernet', makeMatchResult('Cabernet', 0.65)],
        ]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('david arthur cabernet 2014');
      // Multiple weak anchors + constraint (vintage) = mixed or entity_fuzzy
      expect(['mixed_query', 'entity_fuzzy']).toContain(plan.intent);
    });

    it('should handle "red wine from Napa Valley"', async () => {
      const matcher = new StubAliasMatcher(new Map());
      const planner = createPlanner(matcher);

      const plan = await planner.plan('red wine from napa valley');
      expect(plan.intent).toBe('facet_search');
      expect(plan.queryClass).toBe('pure_constraint');
    });

    it('should handle "Opus One-like wine under $100"', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['opus one', makeMatchResult('Opus One', 0.90)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('opus one like wine under 100');
      // Strong anchor + price constraint = mixed
      expect(plan.intent).toBe('mixed_query');
    });

    it('should handle Korean query "오푸스원 같은 카베르네"', async () => {
      const matcher = new StubAliasMatcher(
        new Map([['오푸스원', makeMatchResult('오푸스원', 0.92)]]),
      );
      const planner = createPlanner(matcher);

      const plan = await planner.plan('오푸스원 같은 카베르네');
      expect(plan.intent).toBe('mixed_query');
    });
  });
});
