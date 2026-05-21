/**
 * Phonetic-provenance confidence cap — regression coverage.
 *
 * Root cause guarded here: commit 62b654be ("double-metaphone phonetic
 * encoder") widened the `phonetic_exact` recall lane. Because
 * `phonetic_exact` is classified `exactLike` in `lookup-strategy-taxonomy.ts`
 * (for RECALL), a phonetic-only candidate entered the scorer through the SAME
 * `aliasExactMatch` (weight 0.8) and even `canonicalExactMatch` (weight 1.0)
 * lanes as a genuine exact alias hit. That:
 *   (a) inflated the calibrated confidence C of gibberish above T_resolve, and
 *   (b) let a phonetic collision tie with / outrank an EXACT alias hit.
 *
 * The structural fix lives in `candidate-scorer.ts`:
 *   - `PHONETIC_ONLY_CONTRIBUTION_CEILING` (0.34) clamps the identity-bearing
 *     lanes of a candidate whose every alias match is `aliasType: 'phonetic'`,
 *     keeping its raw total strictly below the smallest per-class `resolveTau`
 *     (0.35) so phonetic-only can never ALONE clear the resolve threshold.
 *   - `phonetic` is removed from `hasCoreAliasMatch`, so the cap engages
 *     instead of being bypassed as "core" evidence.
 *   - corroborating signals (producer / vintage / region) are NOT capped, so a
 *     clearly-intended phonetic match WITH supporting evidence still resolves.
 *
 * These cases are append-only (CLAUDE.md regression discipline) and pure — no
 * I/O, no Postgres, no Vespa.
 */
import { describe, expect, it } from 'vitest';
import { CandidateScorer } from '../../src/domain/resolver/service/candidate-scorer.js';
import type { ResolverCandidate } from '../../src/domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../src/domain/resolver/model/match-signal-set.js';
import type { AliasType } from '../../src/domain/alias/model/alias.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../src/domain/query/model/threshold-profile.js';

const scorer = new CandidateScorer();

/**
 * The phonetic-only cap must keep the raw total below EVERY per-class
 * resolveTau. The smallest one is the binding constraint; assert against it so
 * a future threshold lowering re-triggers this guard.
 */
const SMALLEST_RESOLVE_TAU = ((): number => {
  // Loop, not Math.min(...spread): spread overflows the call stack on large
  // arrays (CLAUDE.md rule 9). Small array here, but keep the safe pattern.
  let smallest = Number.POSITIVE_INFINITY;
  for (const entry of Object.values(DEFAULT_THRESHOLD_PROFILE.perQueryClass)) {
    if (entry.resolveTau < smallest) {
      smallest = entry.resolveTau;
    }
  }
  return smallest;
})();

function makeSignals(overrides?: Partial<MatchSignalSet>): MatchSignalSet {
  return {
    canonicalExactMatch: 0,
    canonicalNormalizedMatch: 0,
    aliasExactMatch: 0,
    aliasFuzzyMatch: 0,
    aliasTypePrior: 0,
    producerMatch: 0,
    vintageMatch: 0,
    regionMatch: 0,
    grapeHintMatch: 0,
    phoneticMatch: 0,
    editDistanceScore: 0,
    ambiguityPenalty: 0,
    ...overrides,
  };
}

function aliasMatch(aliasType: AliasType, matchScore = 1.0): ResolverCandidate['aliasMatches'][number] {
  return { aliasValue: 'surface', aliasType, matchScore };
}

function makeCandidate(
  signals: MatchSignalSet,
  aliasMatches: ResolverCandidate['aliasMatches'],
): ResolverCandidate {
  return {
    entityId: 'wine:test' as ResolverCandidate['entityId'],
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    aliasMatches,
    sourceSignals: signals,
  };
}

describe('phonetic-provenance confidence cap — regression', () => {
  it('gibberish phonetic-only collision stays below every resolveTau (cannot resolve alone)', () => {
    // Mimics the scorer input a `zzz_no_match_*` query produces once Double
    // Metaphone forces a spurious collision: the recall lane sets a full
    // aliasExactMatch (0.8 lane) AND mislabels it as a canonical exact match.
    const signals = makeSignals({
      aliasExactMatch: 1.0,
      canonicalExactMatch: 1.0,
      canonicalNormalizedMatch: 0.95,
      phoneticMatch: 1.0,
    });
    const candidate = makeCandidate(signals, [aliasMatch('phonetic')]);

    const raw = scorer.score(candidate);
    // With identity / isotonic fallback calibration C is monotone in raw and
    // C ≈ min(1, raw) for a singleton, so raw < smallest resolveTau ⇒ C < T_resolve.
    expect(raw).toBeLessThan(SMALLEST_RESOLVE_TAU);
  });

  it('EXACT alias hit dominates a competing phonetic-only collision', () => {
    // Mirrors "romanee conti" (exact) vs a phonetic near-tie collision.
    const exactSignals = makeSignals({
      aliasExactMatch: 1.0,
      canonicalExactMatch: 1.0,
      canonicalNormalizedMatch: 0.95,
    });
    const exactCandidate = makeCandidate(exactSignals, [aliasMatch('canonical')]);

    const phoneticSignals = makeSignals({
      aliasExactMatch: 1.0,
      canonicalExactMatch: 1.0,
      canonicalNormalizedMatch: 0.95,
      phoneticMatch: 1.0,
    });
    const phoneticCandidate = makeCandidate(phoneticSignals, [aliasMatch('phonetic')]);

    const exactRaw = scorer.score(exactCandidate);
    const phoneticRaw = scorer.score(phoneticCandidate);

    expect(exactRaw).toBeGreaterThan(phoneticRaw);
    // The gap must be wide enough that no near-tie survives into the conformal
    // set (exact lane ~1.0+, phonetic-only lane <= ceiling band).
    expect(exactRaw - phoneticRaw).toBeGreaterThan(0.5);
  });

  it('phonetic match WITH corroborating evidence still clears the resolve threshold (no over-correction)', () => {
    // A clearly-intended phonetic match: misspelled name resolved phonetically,
    // PLUS a corroborating vintage + region signal. Corroboration is uncapped.
    const signals = makeSignals({
      aliasExactMatch: 1.0, // capped to the ceiling
      phoneticMatch: 1.0, // capped to the ceiling
      vintageMatch: 1.0, // weight 0.6 — NOT capped
      regionMatch: 1.0, // weight 0.5 — NOT capped
    });
    const candidate = makeCandidate(signals, [aliasMatch('phonetic')]);

    const raw = scorer.score(candidate);
    expect(raw).toBeGreaterThan(SMALLEST_RESOLVE_TAU);
  });

  it('phonetic cap does NOT engage when a non-phonetic alias match coexists', () => {
    // Curated/exact sibling on the same entity must NOT be downgraded by a
    // phonetic sibling — provenance gate uses `every`, not `some`.
    const signals = makeSignals({ aliasExactMatch: 1.0, canonicalExactMatch: 1.0 });
    const mixed = makeCandidate(signals, [aliasMatch('phonetic'), aliasMatch('canonical')]);
    const phoneticOnly = makeCandidate(signals, [aliasMatch('phonetic')]);

    expect(scorer.score(mixed)).toBeGreaterThan(scorer.score(phoneticOnly));
    // The mixed candidate keeps full exact+canonical evidence.
    expect(scorer.score(mixed)).toBeGreaterThan(SMALLEST_RESOLVE_TAU);
  });

  it('non-phonetic candidates are completely unaffected by the cap', () => {
    const signals = makeSignals({ aliasExactMatch: 1.0, canonicalExactMatch: 1.0 });
    const exact = makeCandidate(signals, [aliasMatch('canonical')]);
    // 1.0 (canonicalExact) + 0.8 (aliasExact) = 1.8
    expect(scorer.score(exact)).toBeCloseTo(1.8, 5);
  });

  it('empty aliasMatches (blocker seed) is not treated as phonetic-only', () => {
    const signals = makeSignals({ vintageMatch: 1.0 });
    const seed = makeCandidate(signals, []);
    // vintage weight 0.6 — untouched, no phonetic cap engaged.
    expect(scorer.score(seed)).toBeCloseTo(0.6, 5);
  });
});
