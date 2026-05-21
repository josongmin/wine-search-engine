/**
 * Property-based regression tests for the Static Ambiguity Dictionary
 * (RFC-003). This dictionary is static reference data: a curated lexicon of
 * Korean (and a few Latin) broad surface forms that must NEVER direct-resolve
 * to a single SKU in no-DB / cold-start planner paths. Each entry maps a
 * normalized surface form to a set of disambiguation senses (`types`) and a
 * `severity` hint.
 *
 * Because this is hand-curated reference data merged with a generated
 * catalog (deduped by `normalizeSurface` = NFKC + lowercase + whitespace
 * collapse), the integrity invariants below MUST hold. Any regression here
 * silently corrupts planner ambiguity detection (false direct-resolves or
 * missed disambiguation prompts).
 *
 * Invariants verified (append-only, SOTA++ grade, fast-check numRuns:100):
 *  1. Surface uniqueness — no normalized surface maps to two conflicting
 *     entries. The runtime Map dedupes, so the public surface MUST be a
 *     bijection over normalized keys (curated wins over generated).
 *  2. NFC/NFKC stability — every term's normalized key is stable under
 *     re-normalization (idempotent); no entry's stored term differs from a
 *     re-NFC-normalized form in a way that breaks lookup.
 *  3. Lookup determinism — the same surface looked up 5x returns deeply
 *     equal results (no hidden mutable state / iteration-order leakage).
 *  4. Sense non-empty — every entry has >=1 disambiguation sense in `types`
 *     and a valid severity. An entry with no sense is unactionable.
 *  5. Case-insensitive lookup stability — Latin surfaces (e.g. "drc") resolve
 *     identically regardless of input case (normalizeSurface lowercases).
 *  6. Known ambiguities present — the canonical covered surfaces
 *     (토카이/샤블리/펜폴즈/drc/크리스탈/마고...) resolve to their documented senses.
 *  7. Unknown term => no false match — arbitrary non-dictionary strings
 *     (including random Hangul / Latin / emoji) never produce a false entry.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the source
 * except to fix genuinely malformed data. Any property that legitimately
 * cannot hold is documented in the feature YAML `known_limitations` rather
 * than loosening the test.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  StaticAmbiguityDictionary,
  STATIC_AMBIGUOUS_SURFACES,
  CURATED_CORE_AMBIGUOUS_SURFACES,
  type StaticAmbiguousSurfaceEntry,
} from '../../src/domain/query/service/static-ambiguity-dictionary.js';

const NUM_RUNS = 100;

// Mirror of the private normalizeSurface in the source under test. Kept local
// so the test asserts against the *documented* contract (NFKC + lowercase +
// whitespace collapse + trim) rather than reaching into private internals.
function normalizeSurface(surface: string): string {
  return surface.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);

// Enumerate the REAL public dictionary surface (curated + generated, deduped).
const ALL_ENTRIES: readonly StaticAmbiguousSurfaceEntry[] = STATIC_AMBIGUOUS_SURFACES;
const ALL_TERMS: readonly string[] = ALL_ENTRIES.map((e) => e.term);

describe('StaticAmbiguityDictionary — data integrity properties', () => {
  it('exposes a non-empty curated and merged surface set', () => {
    expect(CURATED_CORE_AMBIGUOUS_SURFACES.length).toBeGreaterThan(0);
    expect(ALL_ENTRIES.length).toBeGreaterThanOrEqual(
      // generated entries can fully overlap curated, so merged >= curated
      CURATED_CORE_AMBIGUOUS_SURFACES.length,
    );
  });

  // Invariant 1: surface uniqueness over normalized keys (no conflicting dup).
  it('has a unique normalized surface per entry (no conflicting duplicates)', () => {
    const seen = new Map<string, StaticAmbiguousSurfaceEntry>();
    for (const entry of ALL_ENTRIES) {
      const key = normalizeSurface(entry.term);
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new Error(
          `Duplicate normalized surface "${key}" from terms ` +
            `"${prior.term}" and "${entry.term}" — conflicting entries.`,
        );
      }
      seen.set(key, entry);
    }
    expect(seen.size).toBe(ALL_ENTRIES.length);
  });

  // Invariant 2: NFC/NFKC normalization stability (idempotent key).
  it('normalizes every term to an NFKC-stable, idempotent key', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_TERMS), (term) => {
        const once = normalizeSurface(term);
        const twice = normalizeSurface(once);
        // Idempotence: normalizing the normalized key is a fixed point.
        expect(twice).toBe(once);
        // The normalized key is in NFC form (NFKC output is NFC-stable).
        expect(once.normalize('NFC')).toBe(once);
        // Non-empty: no entry collapses to an empty surface.
        expect(once.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Invariant 3: lookup determinism (5x identical results).
  it('returns deterministic lookup results across repeated calls', async () => {
    const dict = new StaticAmbiguityDictionary();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ALL_TERMS), async (term) => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () => dict.getAmbiguityInfo(term)),
        );
        const known = await Promise.all(
          Array.from({ length: 5 }, () => dict.isKnownAmbiguous(term)),
        );
        for (const r of results) {
          expect(r).toEqual(results[0]);
        }
        for (const k of known) {
          expect(k).toBe(true);
        }
        expect(results[0]).not.toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Invariant 4: every entry has >=1 sense and a valid severity.
  it('guarantees every entry has at least one disambiguation sense', () => {
    for (const entry of ALL_ENTRIES) {
      expect(Array.isArray(entry.types)).toBe(true);
      expect(entry.types.length).toBeGreaterThanOrEqual(1);
      // No empty / whitespace-only sense strings.
      for (const sense of entry.types) {
        expect(typeof sense).toBe('string');
        expect(sense.trim().length).toBeGreaterThan(0);
      }
      // Senses within an entry are themselves unique (no dup sense noise).
      expect(new Set(entry.types).size).toBe(entry.types.length);
      expect(VALID_SEVERITIES.has(entry.severity)).toBe(true);
    }
  });

  it('returns the stored senses verbatim via getAmbiguityInfo for every entry', async () => {
    const dict = new StaticAmbiguityDictionary();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ALL_ENTRIES), async (entry) => {
        const info = await dict.getAmbiguityInfo(entry.term);
        expect(info).not.toBeNull();
        expect(info?.types).toEqual([...entry.types]);
        expect(info?.severity).toBe(entry.severity);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Invariant 5: case-insensitive lookup stability (Latin surfaces).
  it('looks up case-insensitively (case-folded consistently)', async () => {
    const dict = new StaticAmbiguityDictionary();
    // Latin-bearing surfaces are the ones case-folding can affect.
    const latinTerms = ALL_TERMS.filter((t) => /[a-z]/i.test(t));
    expect(latinTerms.length).toBeGreaterThan(0); // e.g. "drc"
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...latinTerms),
        fc.boolean(),
        async (term, upper) => {
          const variant = upper ? term.toUpperCase() : term.toLowerCase();
          const base = await dict.getAmbiguityInfo(term);
          const cased = await dict.getAmbiguityInfo(variant);
          expect(cased).toEqual(base);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('looks up identically under surrounding/internal whitespace variation', async () => {
    const dict = new StaticAmbiguityDictionary();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_TERMS),
        fc.constantFrom('  ', '\t', ' '),
        async (term, pad) => {
          const base = await dict.getAmbiguityInfo(term);
          const padded = await dict.getAmbiguityInfo(`${pad}${term}${pad}`);
          expect(padded).toEqual(base);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Invariant 6: documented known ambiguities resolve to documented senses.
  // These are the REAL surfaces this dictionary covers (Korean-heavy domain),
  // pinned against silent regression.
  it('resolves canonical known-ambiguous surfaces to documented senses', async () => {
    const dict = new StaticAmbiguityDictionary();
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['토카이', ['region', 'appellation', 'entity']],
      ['샤블리', ['region', 'appellation', 'entity']],
      ['펜폴즈', ['producer', 'entity']],
      ['drc', ['producer_abbreviation', 'entity']],
      ['크리스탈', ['common_noun', 'entity']],
      ['마고', ['region', 'entity']],
      ['바롤로', ['appellation', 'entity']],
      ['페라리', ['producer', 'common_brand', 'entity']],
    ];
    for (const [surface, expectedTypes] of expectations) {
      const info = await dict.getAmbiguityInfo(surface);
      expect(info).not.toBeNull();
      expect(info?.severity).toBe('high');
      expect(info?.types).toEqual([...expectedTypes]);
      // Every documented ambiguity carries >=2 senses (it IS ambiguous).
      expect((info?.types.length ?? 0)).toBeGreaterThanOrEqual(2);
    }
  });

  // Invariant 7: unknown term => no false match (no over-broad lookup).
  it('never produces a false match for non-dictionary strings', async () => {
    const dict = new StaticAmbiguityDictionary();
    const normalizedKeys = new Set(ALL_TERMS.map(normalizeSurface));
    await fc.assert(
      fc.asyncProperty(
        // Mixed Hangul / Latin / accented / emoji / digit noise.
        fc.oneof(
          fc.string(),
          // fast-check v4: full unicode (incl. astral/emoji) via unit:'binary'.
          fc.string({ unit: 'binary' }),
          fc.stringMatching(/^[가-힣]{1,8}$/u),
          fc.stringMatching(/^[a-z0-9]{1,12}$/u),
          fc.constantFrom('🍷', 'café', 'ñoño', '와인을 추천해줘', 'random noise'),
        ),
        async (raw) => {
          fc.pre(!normalizedKeys.has(normalizeSurface(raw)));
          const known = await dict.isKnownAmbiguous(raw);
          const info = await dict.getAmbiguityInfo(raw);
          expect(known).toBe(false);
          expect(info).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('agrees between isKnownAmbiguous and getAmbiguityInfo for arbitrary input', async () => {
    const dict = new StaticAmbiguityDictionary();
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary' }), async (raw) => {
        const known = await dict.isKnownAmbiguous(raw);
        const info = await dict.getAmbiguityInfo(raw);
        // Boolean presence MUST agree with metadata presence.
        expect(known).toBe(info !== null);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
