/**
 * Property-based regression tests for the entity resolver
 * (nlu.entity-resolver feature) — surface form → canonical entity resolution.
 *
 * The resolver pipeline (RFC-006) is exercised end-to-end with the REAL
 * collaborators (CandidateScorer, AmbiguityClassifier, Calibrator on its
 * identity-fallback path) and an in-memory Blocker. The Calibrator is run on
 * its trained-params-absent fallback so the calibrated confidence is a
 * deterministic, monotone function of the raw weighted-sum scores — that keeps
 * the properties below testing the *resolver's* invariants (ordering,
 * determinism, bounding, typed empty result) rather than re-testing a learned
 * calibration curve (which is a separate, product-validation concern).
 *
 * Invariants verified over arbitrary input distributions (fast-check,
 * numRuns: 100) — append-only:
 *
 *  1. Determinism — the same input resolved twice yields byte-identical
 *     status, top entity, ordered candidate IDs and scores. No iteration-order
 *     leakage.
 *  2. Permutation invariance — shuffling the input candidate array does NOT
 *     change the resolution. Ranking is a pure function of (score, entityId),
 *     not of arrival order. This is the strong form of the SSoT-tiebreaker
 *     contract (compareScoreWithTiebreaker).
 *  3. NaN-safe ranking — a candidate whose raw score is NaN/Infinity must NOT
 *     be ranked above a finite-scored candidate. (Regression for the inline
 *     `b - a` tiebreak that left NaN at the front of the list.)
 *  4. Descending score order — emitted candidates are non-increasing in
 *     calibratedScore with the entityId lexicographic tiebreaker on equal raw
 *     scores.
 *  5. Bounded candidate count — the emitted ranked list never exceeds the
 *     named bound MAX_RESOLVED_CANDIDATES, regardless of how large the blocked
 *     pool is.
 *  6. Empty / unknown surface → typed failed result, never a throw, never a
 *     200-shaped resolved status. conformalSetSize === 0, candidates === [].
 *  7. NFC stability on Korean (한글) producer names — a query whose canonical
 *     label is supplied in NFD resolves identically (same top entityId, same
 *     score) to the NFC-composed form. Hangul never routed through `\b`.
 *  8. Accent-variant policy (Château / Chateau) — the documented resolver
 *     policy is that accent folding lives UPSTREAM in normalization, so the
 *     resolver treats the accented and accent-stripped canonical labels as the
 *     SAME entity only when they carry the same entityId; with distinct
 *     entityIds it ranks them deterministically (no accent-dependent crash,
 *     no `\b`).
 *  9. conformalSetSize contract — always a finite integer in [0, k] where k is
 *     the emitted candidate count.
 *
 * Bumps nlu.entity-resolver maturity 3 → 4 (learned-ranking / production-label
 * calibration cross-validation remains an open product-validation gap; see
 * YAML maturity_rationale).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { Resolver, MAX_RESOLVED_CANDIDATES } from '../../src/domain/resolver/service/resolver.js';
import type { ResolverInput } from '../../src/domain/resolver/service/resolver.js';
import { CandidateScorer } from '../../src/domain/resolver/service/candidate-scorer.js';
import { AmbiguityClassifier } from '../../src/domain/resolver/service/ambiguity-classifier.js';
import { Calibrator } from '../../src/domain/resolver/service/calibrator.js';
import type {
  CalibrationStore,
  CalibrationParams,
  FreshCalibrationLoadResult,
} from '../../src/domain/resolver/port/calibration-store.port.js';
import { Blocker } from '../../src/domain/resolver/service/blocker.js';
import type { BlockingPort } from '../../src/domain/resolver/port/blocking.port.js';
import type { ResolverCandidate } from '../../src/domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../src/domain/resolver/model/match-signal-set.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { CanonicalEntityId, QueryClass } from '../../src/domain/shared/types/index.js';

const FC_RUNS = 100;

// ── Deterministic identity calibrator (trained params absent → fallback) ─────

class EmptyCalibrationStore implements CalibrationStore {
  async getCalibrationParams(): Promise<CalibrationParams | null> {
    return null;
  }
  async save(): Promise<void> {
    /* no-op */
  }
  async loadIfFresh(): Promise<FreshCalibrationLoadResult> {
    return { trusted: false, reason: 'never_fitted', params: null };
  }
}

// ── In-memory blocking port that admits the entity IDs it is told to admit ───

class FixedBlockingPort implements BlockingPort {
  constructor(private readonly admit: ReadonlySet<string>) {}
  async block(): Promise<readonly CanonicalEntityId[]> {
    return [...this.admit].map((id) => createCanonicalEntityId(id));
  }
}

function buildResolver(admitIds: readonly string[]): Resolver {
  return new Resolver(
    new Blocker(new FixedBlockingPort(new Set(admitIds))),
    new CandidateScorer(),
    new AmbiguityClassifier(),
    new Calibrator(new EmptyCalibrationStore()),
  );
}

// ── Signal / candidate builders ──────────────────────────────────────────────

function zeroSignals(): MatchSignalSet {
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
  };
}

function makeCandidate(
  id: string,
  label: string,
  signals: Partial<MatchSignalSet>,
): ResolverCandidate {
  return {
    entityId: createCanonicalEntityId(id),
    entityType: 'wine',
    canonicalLabel: label,
    aliasMatches: [{ aliasValue: label, aliasType: 'canonical', matchScore: 1 }],
    sourceSignals: { ...zeroSignals(), ...signals },
    source: 'alias',
    sources: ['alias'],
  };
}

function makeInput(
  candidates: readonly ResolverCandidate[],
  overrides: Partial<ResolverInput> = {},
): ResolverInput {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    queryClass: 'short_entity',
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'hybrid',
      policyReasonCodes: [],
    },
    anchorCandidates: [],
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.9,
      anchorConfidence: 0.9,
      constraintConfidence: 0.9,
    },
    candidateEntities: candidates,
    ...overrides,
  };
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

const scoreUnit = fc.double({ min: 0, max: 1, noNaN: true });

const KOREAN_PRODUCERS = ['오퍼스원', '샤또마고', '로마네꽁띠', '뺑소누', '돔페리뇽'] as const;
const ACCENTED_LATIN = ['Château Margaux', 'Mémé', 'Côte Rôtie', 'Niño'] as const;

const queryClassArb: fc.Arbitrary<QueryClass> = fc.constantFrom(
  'exact_entity',
  'short_entity',
  'ambiguous_short_form',
  'unknown',
);

const candidateArb = (idPrefix: string): fc.Arbitrary<ResolverCandidate> =>
  fc
    .record({
      id: fc.integer({ min: 0, max: 9_999 }),
      label: fc.oneof(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.constantFrom(...KOREAN_PRODUCERS),
        fc.constantFrom(...ACCENTED_LATIN),
      ),
      canonicalNormalizedMatch: scoreUnit,
      aliasExactMatch: scoreUnit,
      aliasFuzzyMatch: scoreUnit,
    })
    .map((r) =>
      makeCandidate(`wine-ce-${idPrefix}-${r.id}`, r.label, {
        canonicalNormalizedMatch: r.canonicalNormalizedMatch,
        aliasExactMatch: r.aliasExactMatch,
        aliasFuzzyMatch: r.aliasFuzzyMatch,
      }),
    );

/** Deduplicate candidates by entityId so the input pool has unique IDs. */
function dedupeById(cands: readonly ResolverCandidate[]): ResolverCandidate[] {
  const seen = new Set<string>();
  const out: ResolverCandidate[] = [];
  for (const c of cands) {
    const key = String(c.entityId);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

const candidatesArb = fc
  .array(candidateArb('p'), { minLength: 1, maxLength: 10 })
  .map(dedupeById)
  .filter((cs) => cs.length >= 1);

function admitAll(cands: readonly ResolverCandidate[]): string[] {
  return cands.map((c) => String(c.entityId));
}

// ── Properties ────────────────────────────────────────────────────────────────

describe('entity-resolver properties (numRuns: 100)', () => {
  it('1. determinism — same input resolves identically twice', async () => {
    await fc.assert(
      fc.asyncProperty(candidatesArb, queryClassArb, async (cands, qc) => {
        const resolver = buildResolver(admitAll(cands));
        const input = makeInput(cands, { queryClass: qc });
        const a = await resolver.resolve(input);
        const b = await resolver.resolve(input);
        expect(b.status).toBe(a.status);
        expect(b.topEntity?.entityId).toBe(a.topEntity?.entityId);
        expect(b.candidates.map((c) => String(c.entityId))).toEqual(
          a.candidates.map((c) => String(c.entityId)),
        );
        expect(b.candidates.map((c) => c.calibratedScore)).toEqual(
          a.candidates.map((c) => c.calibratedScore),
        );
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('2. permutation invariance — input order does not change resolution', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.array(fc.nat(), { minLength: 0, maxLength: 12 }),
        async (cands, perm) => {
          // Derive a permutation deterministically from `perm` via a stable
          // sort of (perm-key, index) so the same multiset is reordered.
          const indexed = cands.map((c, i) => ({ c, k: perm[i] ?? i, i }));
          indexed.sort((x, y) => (x.k - y.k) || (x.i - y.i));
          const shuffled = indexed.map((x) => x.c);

          const resolver = buildResolver(admitAll(cands));
          const ref = await resolver.resolve(makeInput(cands));
          const out = await resolver.resolve(makeInput(shuffled));

          expect(out.candidates.map((c) => String(c.entityId))).toEqual(
            ref.candidates.map((c) => String(c.entityId)),
          );
          expect(out.topEntity?.entityId).toBe(ref.topEntity?.entityId);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('3. NaN/Infinity raw score never outranks a finite-scored candidate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(NaN, Infinity, -Infinity),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        async (poison, finiteSignal) => {
          // Poison candidate: editDistanceScore forced to a non-finite value.
          const poisoned = makeCandidate('wine-ce-aaa-poison', 'poison', {
            editDistanceScore: poison,
          });
          const clean = makeCandidate('wine-ce-zzz-clean', 'clean', {
            canonicalNormalizedMatch: finiteSignal,
            aliasExactMatch: finiteSignal,
          });
          const cands = [poisoned, clean];
          const resolver = buildResolver(admitAll(cands));
          const out = await resolver.resolve(makeInput(cands));
          // The finite-scored clean candidate must rank first; the poisoned
          // (non-finite) one must NOT be top-1.
          expect(out.candidates[0]?.entityId).toBe(clean.entityId);
          expect(out.topEntity?.entityId).toBe(clean.entityId);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('4. emitted candidates are in non-increasing raw-score order with id tiebreak', async () => {
    await fc.assert(
      fc.asyncProperty(candidatesArb, async (cands) => {
        const scorer = new CandidateScorer();
        const resolver = buildResolver(admitAll(cands));
        const out = await resolver.resolve(makeInput(cands));
        const scoreOf = new Map(
          cands.map((c) => [String(c.entityId), scorer.score(c)]),
        );
        for (let i = 1; i < out.candidates.length; i++) {
          const prev = out.candidates[i - 1]!;
          const cur = out.candidates[i]!;
          const ps = scoreOf.get(String(prev.entityId))!;
          const cs = scoreOf.get(String(cur.entityId))!;
          if (ps === cs) {
            // tie → lexicographic ascending entityId
            expect(String(prev.entityId) <= String(cur.entityId)).toBe(true);
          } else {
            expect(ps).toBeGreaterThan(cs);
          }
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('5. emitted candidate count never exceeds MAX_RESOLVED_CANDIDATES', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60 }),
        async (n) => {
          const cands = Array.from({ length: n }, (_, i) =>
            makeCandidate(`wine-ce-bulk-${String(i).padStart(4, '0')}`, `w${i}`, {
              canonicalNormalizedMatch: (i % 7) / 7,
              aliasExactMatch: (i % 5) / 5,
            }),
          );
          const resolver = buildResolver(admitAll(cands));
          const out = await resolver.resolve(makeInput(cands));
          expect(out.candidates.length).toBeLessThanOrEqual(MAX_RESOLVED_CANDIDATES);
          expect(out.candidates.length).toBeLessThanOrEqual(n);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('6. empty/unknown surface → typed failed result, never throws or resolves', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        queryClassArb,
        async (cands, qc) => {
          // Blocker admits NOTHING — every candidate is filtered out.
          const resolver = buildResolver([]);
          const out = await resolver.resolve(makeInput(cands, { queryClass: qc }));
          expect(out.status).toBe('failed');
          expect(out.candidates).toEqual([]);
          expect(out.topEntity).toBeUndefined();
          expect(out.conformalSetSize).toBe(0);
          expect(out.decisionConfidenceC).toBe(0);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('6b. zero-candidate input never throws and returns typed failed result', async () => {
    const resolver = buildResolver([]);
    const out = await resolver.resolve(makeInput([]));
    expect(out.status).toBe('failed');
    expect(out.candidates).toEqual([]);
    expect(out.conformalSetSize).toBe(0);
  });

  it('7. NFC stability — NFD vs NFC Korean canonical label resolve identically', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_PRODUCERS),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        async (producer, signal) => {
          const nfc = producer.normalize('NFC');
          const nfd = producer.normalize('NFD');
          // Same entityId, different normalization form of the label.
          const id = 'wine-ce-kor-1';
          const cNfc = makeCandidate(id, nfc, {
            canonicalNormalizedMatch: signal,
            aliasExactMatch: signal,
          });
          const cNfd = makeCandidate(id, nfd, {
            canonicalNormalizedMatch: signal,
            aliasExactMatch: signal,
          });
          const resolver = buildResolver([id]);
          const a = await resolver.resolve(
            makeInput([cNfc], { rawQuery: nfc, normalizedQuery: nfc }),
          );
          const b = await resolver.resolve(
            makeInput([cNfd], { rawQuery: nfd, normalizedQuery: nfd }),
          );
          expect(b.status).toBe(a.status);
          expect(b.topEntity?.entityId).toBe(a.topEntity?.entityId);
          expect(b.candidates[0]?.calibratedScore).toBe(
            a.candidates[0]?.calibratedScore,
          );
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('8. accent variants (Château/Chateau) — distinct ids rank deterministically, no crash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        async (signal) => {
          const accented = makeCandidate('wine-ce-acc-1', 'Château Margaux', {
            canonicalNormalizedMatch: signal,
            aliasExactMatch: signal,
          });
          const stripped = makeCandidate('wine-ce-acc-2', 'Chateau Margaux', {
            canonicalNormalizedMatch: signal,
            aliasExactMatch: signal,
          });
          const cands = [accented, stripped];
          const resolver = buildResolver(admitAll(cands));
          const a = await resolver.resolve(makeInput(cands));
          const b = await resolver.resolve(makeInput([stripped, accented]));
          // Distinct entities, equal raw scores → deterministic tiebreak by
          // entityId (acc-1 < acc-2), invariant to input order.
          expect(a.candidates.map((c) => String(c.entityId))).toEqual([
            'wine-ce-acc-1',
            'wine-ce-acc-2',
          ]);
          expect(b.candidates.map((c) => String(c.entityId))).toEqual(
            a.candidates.map((c) => String(c.entityId)),
          );
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('9. conformalSetSize is a finite integer in [0, emitted candidate count]', async () => {
    await fc.assert(
      fc.asyncProperty(candidatesArb, queryClassArb, async (cands, qc) => {
        const resolver = buildResolver(admitAll(cands));
        const out = await resolver.resolve(makeInput(cands, { queryClass: qc }));
        expect(Number.isInteger(out.conformalSetSize)).toBe(true);
        expect(out.conformalSetSize).toBeGreaterThanOrEqual(0);
        expect(out.conformalSetSize).toBeLessThanOrEqual(out.candidates.length);
      }),
      { numRuns: FC_RUNS },
    );
  });
});
