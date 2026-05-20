import { describe, it, expect } from 'vitest';
import { ExpansionBuilder } from '../../src/domain/query/service/expansion-builder.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { QueryIntent } from '../../src/domain/query/model/query-intent.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

/**
 * Regression suite for nlu.query-expansion-builder.
 *
 * The builder turns (normalizedQuery, intent, anchors) into an ExpansionBundle.
 * Anchors carry provenance (alias / planner_heuristic / entity_lookup / blocker_seed)
 * and lookupStrategies (exact, fuzzy_char_ngram, transliterated, ...).
 *
 * Maturity-3 invariants under test:
 *   1. Budget cap: |lexical ∪ semantic| ≤ MAX_EXPANSION_TERMS (8).
 *   2. Overlap pruning: same canonical (normalized lowercase) appears once.
 *   3. Deterministic ordering: same input ⇒ same output, repeat 5x.
 *   4. Source priority: exact > alias > transliteration > fuzzy.
 *   5. Korean transliteration & ASCII coexist; mixed input works.
 *   6. Empty / garbage / no-match inputs do not throw.
 */

const entityId = (raw: string): CanonicalEntityId => raw as unknown as CanonicalEntityId;

function anchor(
  surfaceForm: string,
  normalizedForm: string,
  opts: {
    source?: AnchorCandidate['source'];
    lookupStrategies?: readonly string[];
    confidence?: number;
    candidateEntityIds?: readonly CanonicalEntityId[];
  } = {},
): AnchorCandidate {
  return {
    surfaceForm,
    normalizedForm,
    candidateEntityIds: opts.candidateEntityIds ?? [entityId('wine:opus-one')],
    confidence: opts.confidence ?? 0.9,
    source: opts.source ?? 'alias',
    ...(opts.lookupStrategies ? { lookupStrategies: opts.lookupStrategies } : {}),
  };
}

function termsOf(bundle: { lexical: readonly string[]; semantic: readonly string[] }) {
  return [...bundle.lexical, ...bundle.semantic];
}

describe('regression: query-expansion-builder (maturity 3)', () => {
  const builder = new ExpansionBuilder();

  describe('Korean transliteration expansion', () => {
    it('"오푸스 원" → expansion includes "opus one" (transliterated normalized form)', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('오푸스 원', 'opus one', {
          source: 'alias',
          lookupStrategies: ['transliterated'],
        }),
      ];

      const bundle = builder.build('오푸스 원', 'entity_exact' satisfies QueryIntent, anchors);

      expect(bundle.lexical).toContain('opus one');
      expect(bundle.lexical.length).toBeGreaterThan(0);
    });

    it('mixed Korean + ASCII anchors (entity_fuzzy) keep both transliterated and original semantic phrase', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('오푸스', 'opus', { source: 'alias', lookupStrategies: ['transliterated'] }),
        anchor('one', 'one', { source: 'alias', lookupStrategies: ['exact'] }),
      ];

      const bundle = builder.build('오푸스 one', 'entity_fuzzy', anchors);

      expect(bundle.lexical).toContain('opus');
      expect(bundle.lexical).toContain('one');
      expect(bundle.semantic).toContain('오푸스 one');
    });
  });

  describe('typo / fuzzy expansion', () => {
    it('entity_fuzzy with fuzzy_char_ngram anchor includes canonical normalized form', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('opuss one', 'opus one', {
          source: 'planner_heuristic',
          lookupStrategies: ['fuzzy_char_ngram'],
          confidence: 0.78,
        }),
      ];

      const bundle = builder.build('opuss one', 'entity_fuzzy', anchors);

      expect(bundle.lexical).toContain('opus one');
      expect(bundle.semantic).toContain('opuss one');
    });
  });

  describe('budget cap', () => {
    it('many anchors → bundle terms ≤ MAX_EXPANSION_TERMS (8)', () => {
      const many: AnchorCandidate[] = Array.from({ length: 25 }, (_, i) =>
        anchor(`surface-${i}`, `canon-${i}`, {
          source: i % 2 === 0 ? 'alias' : 'planner_heuristic',
          lookupStrategies: i % 3 === 0 ? ['exact'] : ['fuzzy_char_ngram'],
        }),
      );

      const bundle = builder.build('q', 'comparison_search', many);

      const total = termsOf(bundle).length;
      expect(total).toBeLessThanOrEqual(8);
    });

    it('boundary: exactly cap anchors → exactly cap terms', () => {
      const eight: AnchorCandidate[] = Array.from({ length: 8 }, (_, i) =>
        anchor(`surface-${i}`, `canon-${i}`, {
          source: 'alias',
          lookupStrategies: ['exact'],
        }),
      );

      const bundle = builder.build('q', 'entity_exact', eight);

      expect(bundle.lexical.length).toBe(8);
    });
  });

  describe('overlap pruning (dedup by canonical form)', () => {
    it('same normalized canonical via multiple anchors appears once', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('Opus One', 'opus one', { lookupStrategies: ['exact'] }),
        anchor('opus one', 'opus one', { lookupStrategies: ['exact'] }),
        anchor('오푸스 원', 'opus one', { lookupStrategies: ['transliterated'] }),
        anchor('opuss one', 'opus one', { lookupStrategies: ['fuzzy_char_ngram'] }),
      ];

      const bundle = builder.build('opus one', 'comparison_search', anchors);

      const occurrences = bundle.lexical.filter((t) => t.toLowerCase() === 'opus one').length;
      expect(occurrences).toBe(1);
    });

    it('case-insensitive dedup: "Opus One" and "opus one" collapse', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('Opus One', 'Opus One', { lookupStrategies: ['exact'] }),
        anchor('opus one', 'opus one', { lookupStrategies: ['exact'] }),
      ];

      const bundle = builder.build('opus one', 'entity_exact', anchors);

      expect(bundle.lexical.length).toBe(1);
    });
  });

  describe('deterministic ordering', () => {
    it('same query 5x → identical bundle each time', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('오푸스 원', 'opus one', {
          source: 'alias',
          lookupStrategies: ['transliterated'],
        }),
        anchor('opuss one', 'opus one fuzzy', {
          source: 'planner_heuristic',
          lookupStrategies: ['fuzzy_char_ngram'],
        }),
        anchor('Opus', 'opus', { source: 'alias', lookupStrategies: ['exact'] }),
      ];

      const runs = Array.from({ length: 5 }, () =>
        builder.build('오푸스 원', 'comparison_search', anchors),
      );

      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]!.lexical).toEqual(runs[0]!.lexical);
        expect(runs[i]!.semantic).toEqual(runs[0]!.semantic);
      }
    });

    it('source-priority ordering: exact appears before fuzzy', () => {
      const anchors: readonly AnchorCandidate[] = [
        anchor('fuzzy-hit', 'fuzzy-hit', {
          source: 'planner_heuristic',
          lookupStrategies: ['fuzzy_char_ngram'],
        }),
        anchor('exact-hit', 'exact-hit', {
          source: 'alias',
          lookupStrategies: ['exact'],
        }),
        anchor('translit-hit', 'translit-hit', {
          source: 'alias',
          lookupStrategies: ['transliterated'],
        }),
      ];

      const bundle = builder.build('q', 'comparison_search', anchors);

      const exactIdx = bundle.lexical.indexOf('exact-hit');
      const translitIdx = bundle.lexical.indexOf('translit-hit');
      const fuzzyIdx = bundle.lexical.indexOf('fuzzy-hit');

      expect(exactIdx).toBeGreaterThanOrEqual(0);
      expect(translitIdx).toBeGreaterThanOrEqual(0);
      expect(fuzzyIdx).toBeGreaterThanOrEqual(0);
      expect(exactIdx).toBeLessThan(translitIdx);
      expect(translitIdx).toBeLessThan(fuzzyIdx);
    });
  });

  describe('degenerate inputs (no throw)', () => {
    it('empty normalized query + empty anchors → empty bundle', () => {
      expect(() => builder.build('', 'entity_exact', [])).not.toThrow();
      const bundle = builder.build('', 'entity_exact', []);
      expect(bundle.lexical).toEqual([]);
      expect(bundle.semantic).toEqual([]);
    });

    it('garbage query with no anchors → empty lexical, no throw', () => {
      expect(() =>
        builder.build('!@#$%^&*()', 'entity_exact', []),
      ).not.toThrow();
      const bundle = builder.build('!@#$%^&*()', 'entity_exact', []);
      expect(bundle.lexical).toEqual([]);
    });

    it('single-token query (constraint expansion) returns non-empty when token length > 1', () => {
      const bundle = builder.build('bordeaux', 'facet_search', []);
      expect(bundle.lexical).toContain('bordeaux');
    });

    it('multi-token query (constraint expansion) returns each token', () => {
      const bundle = builder.build('bordeaux 2015 reserve', 'facet_search', []);
      expect(bundle.lexical).toContain('bordeaux');
      expect(bundle.lexical).toContain('2015');
      expect(bundle.lexical).toContain('reserve');
    });
  });
});
