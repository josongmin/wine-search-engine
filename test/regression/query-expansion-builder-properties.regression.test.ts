/**
 * Property-based regression tests for `nlu.query-expansion-builder` (SOTA++).
 *
 * The ExpansionBuilder turns (normalizedQuery, intent, anchors) into an
 * ExpansionBundle (lexical + semantic). It is invoked on every query and feeds
 * downstream sparse/dense retrieval — silent regressions corrupt both recall
 * (terms dropped) and precision (caps violated, duplicates introduced).
 *
 * Invariants verified (append-only, SOTA++ grade, fast-check numRuns:100):
 *   1. Budget cap — for ALL intents and any anchor count, the combined
 *      |lexical| + |semantic| ≤ MAX_EXPANSION_TERMS.
 *   2. Determinism — same (query, intent, anchors) → identical bundle when
 *      repeated 5x. No hidden mutable state / iteration-order leakage.
 *   3. Case-insensitive global uniqueness — no two emitted terms share a
 *      case-folded form across lexical+semantic.
 *   4. Source-priority ordering — within the lexical list emitted by
 *      anchor-driven intents (entity_exact / comparison_search), an anchor
 *      whose best lookupStrategy is `exact` precedes any whose best is
 *      `fuzzy_char_ngram`, all else equal.
 *   5. NFC stability — Korean inputs already in NFC remain in NFC in the
 *      emitted terms. The builder MUST NOT mojibake / re-decompose Hangul.
 *   6. Non-empty terms only — no emitted term is the empty string. This is a
 *      non-trivial guard: feeding an empty query into a semantic-emitting
 *      intent must NOT inject `''` into the bundle.
 *   7. Input non-mutation — the input anchors array is not mutated in place
 *      (length unchanged, order unchanged on the original reference).
 *   8. Korean transliteration recall — when an anchor carries an ASCII
 *      `normalizedForm` and a `transliterated` lookupStrategy, the ASCII
 *      canonical form is present in the lexical bundle (recall guard for
 *      Korean→Latin alias retrieval).
 *
 * Touch-policy: this file is regression-only and append-only. It does NOT
 * relax the source contract to make a property pass. Any property that
 * genuinely cannot hold is documented in
 * `tools/feature-catalog/features/nlu/query-expansion-builder.yaml`
 * under `known_limitations`.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  ExpansionBuilder,
  MAX_EXPANSION_TERMS,
} from '../../src/domain/query/service/expansion-builder.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import { QUERY_INTENTS, type QueryIntent } from '../../src/domain/query/model/query-intent.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

const NUM_RUNS = 100;

/** Repeat count for determinism property — matches existing regression suite. */
const DETERMINISM_REPEATS = 5;

const entityId = (raw: string): CanonicalEntityId =>
  raw as unknown as CanonicalEntityId;

/** Anchor sources accepted by the AnchorCandidate model. */
const ANCHOR_SOURCES = ['alias', 'planner_heuristic', 'entity_lookup', 'blocker_seed'] as const;

/** Lookup strategies the builder is aware of (ranked highest → lowest priority). */
const LOOKUP_STRATEGIES = ['exact', 'compact_exact', 'alias', 'transliterated', 'fuzzy_char_ngram', 'fuzzy'] as const;

/** All intents the builder must handle. */
const ALL_INTENTS: readonly QueryIntent[] = QUERY_INTENTS;

/**
 * Arbitrary for a non-empty surface form. We deliberately allow Unicode
 * (Hangul, accented Latin, emoji-free letters) to catch NFC regressions and
 * boundary handling on non-ASCII input.
 */
const surfaceArb = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0);

const normalizedArb = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0)
  // Normalize so equality / NFC assertions are meaningful.
  .map((s) => s.normalize('NFC'));

const anchorArb: fc.Arbitrary<AnchorCandidate> = fc.record({
  surfaceForm: surfaceArb,
  normalizedForm: normalizedArb,
  candidateEntityIds: fc.constant([entityId('wine:test')] as readonly CanonicalEntityId[]),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  source: fc.constantFrom(...ANCHOR_SOURCES),
  lookupStrategies: fc.subarray([...LOOKUP_STRATEGIES], { minLength: 0, maxLength: 3 }),
});

const queryArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s.trim().length > 0)
  .map((s) => s.normalize('NFC'));

const intentArb = fc.constantFrom(...ALL_INTENTS);

const anchorsArb = fc.array(anchorArb, { minLength: 0, maxLength: 25 });

const bundleTerms = (b: { lexical: readonly string[]; semantic: readonly string[] }): string[] =>
  [...b.lexical, ...b.semantic];

describe('property: query-expansion-builder (SOTA++ maturity 5)', () => {
  const builder = new ExpansionBuilder();

  it('Property 1 — budget cap: |lexical ∪ semantic| ≤ MAX_EXPANSION_TERMS for every intent', () => {
    fc.assert(
      fc.property(queryArb, intentArb, anchorsArb, (q, intent, anchors) => {
        const bundle = builder.build(q, intent, anchors);
        const total = bundle.lexical.length + bundle.semantic.length;
        expect(total).toBeLessThanOrEqual(MAX_EXPANSION_TERMS);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 2 — determinism: same input repeated 5x → identical bundles', () => {
    fc.assert(
      fc.property(queryArb, intentArb, anchorsArb, (q, intent, anchors) => {
        const baseline = builder.build(q, intent, anchors);
        for (let i = 0; i < DETERMINISM_REPEATS; i++) {
          const next = builder.build(q, intent, anchors);
          expect(next.lexical).toEqual(baseline.lexical);
          expect(next.semantic).toEqual(baseline.semantic);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 3 — case-insensitive global uniqueness across lexical ∪ semantic', () => {
    fc.assert(
      fc.property(queryArb, intentArb, anchorsArb, (q, intent, anchors) => {
        const bundle = builder.build(q, intent, anchors);
        const keys = bundleTerms(bundle).map((t) => t.toLowerCase());
        const unique = new Set(keys);
        expect(unique.size).toBe(keys.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 4 — source-priority: exact anchor precedes fuzzy anchor in entity_exact / comparison_search lexical', () => {
    // Targeted property: build a controlled pair where one anchor has only
    // `exact` strategy and the other only `fuzzy_char_ngram`, then assert the
    // exact one appears first regardless of input order.
    const pairArb = fc.record({
      exactForm: normalizedArb.filter((s) => s.toLowerCase() !== ''),
      fuzzyForm: normalizedArb.filter((s) => s.toLowerCase() !== ''),
      reverseOrder: fc.boolean(),
      intent: fc.constantFrom<QueryIntent>('entity_exact', 'comparison_search'),
    });

    fc.assert(
      fc.property(pairArb, ({ exactForm, fuzzyForm, reverseOrder, intent }) => {
        // Skip degenerate case where canonical forms collide → dedup eats one.
        fc.pre(exactForm.toLowerCase() !== fuzzyForm.toLowerCase());

        const exactAnchor: AnchorCandidate = {
          surfaceForm: exactForm,
          normalizedForm: exactForm,
          candidateEntityIds: [entityId('wine:exact')],
          confidence: 0.9,
          source: 'alias',
          lookupStrategies: ['exact'],
        };
        const fuzzyAnchor: AnchorCandidate = {
          surfaceForm: fuzzyForm,
          normalizedForm: fuzzyForm,
          candidateEntityIds: [entityId('wine:fuzzy')],
          confidence: 0.9,
          source: 'planner_heuristic',
          lookupStrategies: ['fuzzy_char_ngram'],
        };
        const anchors = reverseOrder ? [fuzzyAnchor, exactAnchor] : [exactAnchor, fuzzyAnchor];
        const bundle = builder.build('q', intent, anchors);

        const exactIdx = bundle.lexical.indexOf(exactForm);
        const fuzzyIdx = bundle.lexical.indexOf(fuzzyForm);
        expect(exactIdx).toBeGreaterThanOrEqual(0);
        expect(fuzzyIdx).toBeGreaterThanOrEqual(0);
        expect(exactIdx).toBeLessThan(fuzzyIdx);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 5 — NFC stability: Korean NFC inputs stay NFC in emitted terms', () => {
    // Hangul syllable arbitrary (precomposed, NFC-stable single code points).
    const hangulSyllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));
    const hangulWord = fc.array(hangulSyllable, { minLength: 1, maxLength: 6 }).map((cs) => cs.join(''));

    fc.assert(
      fc.property(hangulWord, intentArb, fc.array(hangulWord, { minLength: 0, maxLength: 4 }), (q, intent, surfaces) => {
        const anchors: AnchorCandidate[] = surfaces.map((s, i) => ({
          surfaceForm: s,
          normalizedForm: s,
          candidateEntityIds: [entityId(`wine:k-${i}`)],
          confidence: 0.8,
          source: 'alias',
          lookupStrategies: ['exact'],
        }));
        const bundle = builder.build(q, intent, anchors);
        for (const term of bundleTerms(bundle)) {
          expect(term).toEqual(term.normalize('NFC'));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 6 — no empty-string terms emitted (even when query/anchors degenerate)', () => {
    // Include the degenerate empty/whitespace query so the property covers the
    // semantic-emitting intents (semantic_discovery, pairing_search,
    // mixed_query, entity_fuzzy) which would otherwise leak '' into the bundle.
    const maybeEmptyQuery = fc.oneof(fc.constant(''), fc.constant('   '), queryArb);
    fc.assert(
      fc.property(maybeEmptyQuery, intentArb, anchorsArb, (q, intent, anchors) => {
        const bundle = builder.build(q, intent, anchors);
        for (const term of bundleTerms(bundle)) {
          expect(term).not.toBe('');
          expect(term.trim()).not.toBe('');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 7 — input anchors array is not mutated', () => {
    fc.assert(
      fc.property(queryArb, intentArb, anchorsArb, (q, intent, anchors) => {
        const lengthBefore = anchors.length;
        const orderSnapshot = anchors.map((a) => a.normalizedForm);
        builder.build(q, intent, anchors);
        expect(anchors.length).toBe(lengthBefore);
        expect(anchors.map((a) => a.normalizedForm)).toEqual(orderSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Property 8 — Korean transliteration recall: ASCII normalizedForm with `transliterated` strategy appears in lexical', () => {
    // Targeted property: any anchor-driven intent must include the ASCII
    // canonical form when the strategy is transliterated. This guards the
    // 오푸스 → "opus one" recall path for both entity_exact and comparison_search.
    const asciiCanonicalArb = fc
      .stringMatching(/^[a-z][a-z0-9 ]{0,10}[a-z0-9]$/)
      .filter((s) => s.trim().length > 1);

    const intentSubset = fc.constantFrom<QueryIntent>('entity_exact', 'comparison_search', 'mixed_query');

    fc.assert(
      fc.property(asciiCanonicalArb, intentSubset, (canonical, intent) => {
        const anchor: AnchorCandidate = {
          surfaceForm: '오푸스 원',
          normalizedForm: canonical,
          candidateEntityIds: [entityId('wine:translit')],
          confidence: 0.9,
          source: 'alias',
          lookupStrategies: ['transliterated'],
        };
        const bundle = builder.build('오푸스 원', intent, [anchor]);
        expect(bundle.lexical).toContain(canonical);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
