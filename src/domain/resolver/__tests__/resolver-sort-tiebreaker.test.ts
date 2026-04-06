/**
 * Regression test for the resolver sort tiebreaker.
 *
 * When two candidates have identical raw scores (e.g. vintage siblings
 * "Opus One 2018" and "Opus One 2019" matched with the same alias signals),
 * the resolver must produce a deterministic ordering across calls.
 *
 * Prior to the fix, `blendedScored.sort((a, b) => b.rawScore - a.rawScore)`
 * returned 0 for tied pairs, producing undefined ordering that could vary
 * depending on the input permutation — which meant replay could produce
 * different ranked results.
 */

import { describe, it, expect } from 'vitest';
import { createEntityId } from '../../shared/types/index.js';
import { CandidateScorer } from '../service/candidate-scorer.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { MatchSignalSet } from '../model/match-signal-set.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ZERO_SIGNALS: MatchSignalSet = {
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
};

function makeCandidate(entityId: string, signals: Partial<MatchSignalSet> = {}): ResolverCandidate {
  return {
    entityId: createEntityId(entityId),
    entityType: 'wine',
    canonicalLabel: entityId,
    aliasMatches: [{ aliasValue: 'opus one', aliasType: 'canonical', matchScore: 0.9 }],
    sourceSignals: { ...ZERO_SIGNALS, ...signals },
  };
}

/**
 * Simulates the sort applied in Resolver.resolve() after scoring.
 * Extracted here so we can unit-test the comparator in isolation.
 */
function resolverSort(
  scored: Array<{ candidate: ResolverCandidate; rawScore: number }>,
): Array<{ candidate: ResolverCandidate; rawScore: number }> {
  return [...scored].sort((a, b) => {
    const scoreDiff = b.rawScore - a.rawScore;
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.candidate.entityId).localeCompare(String(b.candidate.entityId));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Resolver sort tiebreaker', () => {
  const scorer = new CandidateScorer();

  it('produces consistent ordering for candidates with identical raw scores regardless of input order', () => {
    const signals: Partial<MatchSignalSet> = { aliasExactMatch: 0.9 };
    const c2018 = makeCandidate('opus-one-2018', signals);
    const c2019 = makeCandidate('opus-one-2019', signals);

    const score2018 = scorer.score(c2018);
    const score2019 = scorer.score(c2019);

    // Both candidates must have the same raw score for this test to be valid
    expect(score2018).toBe(score2019);

    const inputOrderA = [
      { candidate: c2018, rawScore: score2018 },
      { candidate: c2019, rawScore: score2019 },
    ];
    const inputOrderB = [
      { candidate: c2019, rawScore: score2019 },
      { candidate: c2018, rawScore: score2018 },
    ];

    const sortedA = resolverSort(inputOrderA);
    const sortedB = resolverSort(inputOrderB);

    // Regardless of input order, the result must be identical
    expect(sortedA.map((s) => String(s.candidate.entityId))).toEqual(
      sortedB.map((s) => String(s.candidate.entityId)),
    );
  });

  it('ranks higher raw score first when scores differ', () => {
    const high = makeCandidate('candidate-high', { aliasExactMatch: 1.0, canonicalExactMatch: 1.0 });
    const low = makeCandidate('candidate-low', { aliasExactMatch: 0.1 });

    const highScore = scorer.score(high);
    const lowScore = scorer.score(low);
    expect(highScore).toBeGreaterThan(lowScore);

    const sorted = resolverSort([
      { candidate: low, rawScore: lowScore },
      { candidate: high, rawScore: highScore },
    ]);

    expect(String(sorted[0]?.candidate.entityId)).toBe('candidate-high');
    expect(String(sorted[1]?.candidate.entityId)).toBe('candidate-low');
  });
});
