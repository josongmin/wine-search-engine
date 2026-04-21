/**
 * T5.5a unit tests for DefaultRankingPolicy.
 *
 * Covers:
 *  - producer diversity: extras beyond 3 in top-10 are demoted to after rank 10
 *  - maxResults truncation: list is cut to context.maxResults when set
 *  - rank re-assignment: ranks are always 1-based contiguous after apply()
 *  - no-op when no diversity violation and no maxResults
 */

import { describe, it, expect } from 'vitest';
import { DefaultRankingPolicy } from '../../../src/domain/ranking/service/default-ranking-policy.js';
import type { RankedResult, ComponentScores } from '../../../src/domain/ranking/model/ranked-result.js';
import type { PolicyContext } from '../../../src/domain/ranking/port/ranking-policy.port.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const STUB_COMPONENT_SCORES: ComponentScores = {
  entityIntegrity: 0.8,
  semantic: 0.5,
  hardConstraintPass: true,
  softConstraint: 0.5,
  attributeAlignment: 0.5,
  preferenceAlignment: 0.5,
  popularity: 0.3,
  availability: 1.0,
  uncertaintyPenalty: 0.1,
};

function makeResult(
  id: string,
  rank: number,
  options?: { producer?: string; finalScore?: number; grapePrimary?: string },
): RankedResult {
  return {
    entityId: createEntityId(id),
    canonicalLabel: `Wine ${id}`,
    finalScore: options?.finalScore ?? 1.0 - rank * 0.05,
    rank,
    componentScores: STUB_COMPONENT_SCORES,
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    ...(options?.producer !== undefined ? { producer: options.producer } : {}),
    ...(options?.grapePrimary !== undefined ? { grapePrimary: options.grapePrimary } : {}),
  };
}

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    queryClass: 'semantic_preference',
    effectiveRoute: 'hybrid',
    ...overrides,
  };
}

function makeList(
  count: number,
  options?: { producer?: string },
): readonly RankedResult[] {
  return Array.from({ length: count }, (_, i) =>
    makeResult(`wine-${String(i + 1).padStart(2, '0')}`, i + 1, options),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DefaultRankingPolicy (T5.5a)', () => {
  const policy = new DefaultRankingPolicy();

  // ── No-op cases ──────────────────────────────────────────────────────────

  describe('no-op / identity cases', () => {
    it('returns same results when no diversity violations and no maxResults', () => {
      const results = [
        makeResult('a', 1, { producer: 'Chateau A' }),
        makeResult('b', 2, { producer: 'Chateau B' }),
        makeResult('c', 3, { producer: 'Chateau C' }),
      ];
      const out = policy.apply(results, makeContext());
      expect(out).toHaveLength(3);
      expect(out.map((r) => String(r.entityId))).toEqual(
        results.map((r) => String(r.entityId)),
      );
    });

    it('preserves order when all producers are distinct in the top window', () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeResult(`wine-${i}`, i + 1, { producer: `Producer ${i}` }),
      );
      const out = policy.apply(results, makeContext());
      expect(out.map((r) => String(r.entityId))).toEqual(
        results.map((r) => String(r.entityId)),
      );
    });

    it('returns empty array when given empty input', () => {
      expect(policy.apply([], makeContext())).toHaveLength(0);
    });

    it('does not apply wine-type diversity when a direct grape_primary constraint already grounds the query', () => {
      const results = [
        { ...makeResult('gris-1', 1, { grapePrimary: 'Pinot Gris' }), wineType: 'white' },
        { ...makeResult('gris-2', 2, { grapePrimary: 'Pinot Gris' }), wineType: 'white' },
        { ...makeResult('gris-3', 3, { grapePrimary: 'Pinot Gris' }), wineType: 'white' },
        { ...makeResult('noir-1', 4, { grapePrimary: 'Pinot Noir' }), wineType: 'red' },
      ];

      const out = policy.apply(results, makeContext({
        hasDirectGrapePrimaryConstraint: true,
      }));

      expect(out.map((result) => String(result.entityId))).toEqual([
        'gris-1',
        'gris-2',
        'gris-3',
        'noir-1',
      ]);
    });
  });

  // ── Rank re-assignment ────────────────────────────────────────────────────

  describe('rank re-assignment', () => {
    it('always produces 1-based contiguous ranks', () => {
      const results = makeList(5);
      const out = policy.apply(results, makeContext());
      expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    });

    it('re-assigns ranks after diversity reordering', () => {
      // 5 results from the same producer → 4th and 5th get demoted
      const results = Array.from({ length: 5 }, (_, i) =>
        makeResult(`wine-${i}`, i + 1, { producer: 'Same Producer' }),
      );
      const out = policy.apply(results, makeContext());
      expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    });

    it('re-assigns ranks after maxResults truncation', () => {
      const results = makeList(10);
      const out = policy.apply(results, makeContext({ maxResults: 3 }));
      expect(out.map((r) => r.rank)).toEqual([1, 2, 3]);
    });
  });

  // ── Producer diversity ────────────────────────────────────────────────────

  describe('producer diversity', () => {
    it('allows exactly 3 results from the same producer in the top window', () => {
      const results = [
        makeResult('a', 1, { producer: 'Opus One' }),
        makeResult('b', 2, { producer: 'Opus One' }),
        makeResult('c', 3, { producer: 'Opus One' }),
        makeResult('d', 4, { producer: 'Other' }),
      ];
      const out = policy.apply(results, makeContext());
      // No demotion — exactly 3 from Opus One
      const opusIds = out.filter((r) => r.producer === 'Opus One').map((r) => r.rank);
      expect(opusIds).toHaveLength(3);
      // First three positions should be Opus One
      expect(out[0]?.producer).toBe('Opus One');
      expect(out[1]?.producer).toBe('Opus One');
      expect(out[2]?.producer).toBe('Opus One');
      // 4번째는 반드시 Other — Opus One이 4번째에 있으면 정책 위반
      expect(out[3]?.producer).toBe('Other');
      // 전체 Opus One 개수가 3개로 고정 (4개로 늘어나는 퇴행 방지)
      expect(out.filter((r) => r.producer === 'Opus One')).toHaveLength(3);
    });

    it('demotes 4th+ occurrences of same producer to after position 10', () => {
      // 5 from same producer in positions 1-5, 5 different producers in 6-10
      const results: RankedResult[] = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeResult(`opus-${i}`, i + 1, { producer: 'Opus One' }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeResult(`other-${i}`, i + 6, { producer: `Other ${i}` }),
        ),
      ];
      const out = policy.apply(results, makeContext());

      // First 3 positions should be Opus One
      expect(out[0]?.producer).toBe('Opus One');
      expect(out[1]?.producer).toBe('Opus One');
      expect(out[2]?.producer).toBe('Opus One');

      // Positions 4-8 should be the 5 "Other" producers
      const positionsOf4thPlus = out
        .slice(3, 8)
        .map((r) => r.producer ?? '');
      expect(positionsOf4thPlus.every((p) => p.startsWith('Other'))).toBe(true);

      // Demoted opus results should appear at positions 9 and 10 (0-indexed 8 and 9)
      const demotedOpus = out.slice(8, 10).map((r) => r.producer);
      expect(demotedOpus).toEqual(['Opus One', 'Opus One']);
    });

    it('demotes exactly the excess results, not all same-producer results', () => {
      // 4 from same producer → only the 4th should be demoted
      const results: RankedResult[] = [
        makeResult('opus-1', 1, { producer: 'Opus One' }),
        makeResult('opus-2', 2, { producer: 'Opus One' }),
        makeResult('opus-3', 3, { producer: 'Opus One' }),
        makeResult('opus-4', 4, { producer: 'Opus One' }), // should be demoted
        makeResult('other-1', 5, { producer: 'Chateau B' }),
      ];
      const out = policy.apply(results, makeContext());
      expect(out).toHaveLength(5);

      // Positions 1-3: first three Opus One wines
      expect(out[0]?.entityId).toStrictEqual(createEntityId('opus-1'));
      expect(out[1]?.entityId).toStrictEqual(createEntityId('opus-2'));
      expect(out[2]?.entityId).toStrictEqual(createEntityId('opus-3'));

      // Position 4: the non-Opus wine moves up
      expect(out[3]?.entityId).toStrictEqual(createEntityId('other-1'));

      // Position 5: the demoted 4th Opus wine
      expect(out[4]?.entityId).toStrictEqual(createEntityId('opus-4'));
    });

    it('does not demote results beyond position 10 (outside diversity window)', () => {
      // 5 from same producer but 2 are already in positions 11+
      const results: RankedResult[] = [
        ...Array.from({ length: 3 }, (_, i) =>
          makeResult(`opus-top-${i}`, i + 1, { producer: 'Opus One' }),
        ),
        ...Array.from({ length: 7 }, (_, i) =>
          makeResult(`other-${i}`, i + 4, { producer: `Other ${i}` }),
        ),
        // These are already outside the top 10 — diversity rule doesn't touch them
        makeResult('opus-11', 11, { producer: 'Opus One' }),
        makeResult('opus-12', 12, { producer: 'Opus One' }),
      ];
      const out = policy.apply(results, makeContext());
      // Exactly 3 Opus One in top 10 — no demotion needed
      const top10OpusCount = out.slice(0, 10).filter((r) => r.producer === 'Opus One').length;
      expect(top10OpusCount).toBe(3);
      // opus-11 and opus-12 stay at the tail (unchanged)
      expect(out[10]?.entityId).toStrictEqual(createEntityId('opus-11'));
      expect(out[11]?.entityId).toStrictEqual(createEntityId('opus-12'));
    });

    it('results without a producer field are never demoted', () => {
      // 5 results with no producer + 3 with a producer
      const results: RankedResult[] = [
        ...Array.from({ length: 5 }, (_, i) => makeResult(`anon-${i}`, i + 1)), // no producer
        ...Array.from({ length: 3 }, (_, i) =>
          makeResult(`chateau-${i}`, i + 6, { producer: 'Chateau A' }),
        ),
      ];
      const out = policy.apply(results, makeContext());
      // anon results should all remain in the first 5 positions
      const anonOut = out.slice(0, 5).every((r) => r.producer === undefined);
      expect(anonOut).toBe(true);
    });

    it('handles multiple distinct producers each hitting the limit', () => {
      // 4 from Producer A, 4 from Producer B in top 8; extras demoted
      const results: RankedResult[] = [
        makeResult('a1', 1, { producer: 'Producer A' }),
        makeResult('b1', 2, { producer: 'Producer B' }),
        makeResult('a2', 3, { producer: 'Producer A' }),
        makeResult('b2', 4, { producer: 'Producer B' }),
        makeResult('a3', 5, { producer: 'Producer A' }),
        makeResult('b3', 6, { producer: 'Producer B' }),
        makeResult('a4', 7, { producer: 'Producer A' }), // demoted
        makeResult('b4', 8, { producer: 'Producer B' }), // demoted
      ];
      const out = policy.apply(results, makeContext());
      expect(out).toHaveLength(8);
      // First 6 should be the non-demoted ones in original relative order
      const first6 = out.slice(0, 6).map((r) => String(r.entityId));
      expect(first6).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
      // Last 2 are the demoted extras
      const last2 = out.slice(6).map((r) => String(r.entityId));
      expect(last2).toEqual(['a4', 'b4']);
    });
  });

  // ── maxResults truncation ─────────────────────────────────────────────────

  describe('ambiguous branch diversity', () => {
    it('promotes distinct ambiguity branches ahead of repeated same-branch results', () => {
      const results: RankedResult[] = [
        makeResult('pn-1', 1, { grapePrimary: 'Pinot Noir' }),
        makeResult('pn-2', 2, { grapePrimary: 'Pinot Noir' }),
        makeResult('pg-1', 3, { grapePrimary: 'Pinot Grigio' }),
        makeResult('pg-2', 4, { grapePrimary: 'Pinot Gris' }),
      ];

      const out = policy.apply(results, makeContext({
        queryClass: 'semantic_preference',
        ambiguousBranchGroups: [
          { label: 'Pinot Noir', matchValues: ['Pinot Noir'] },
          { label: 'Pinot Gris', matchValues: ['Pinot Gris', 'Pinot Grigio'] },
          { label: 'Pinot Blanc', matchValues: ['Pinot Blanc'] },
        ],
      }));

      expect(out.map((result) => String(result.entityId))).toEqual([
        'pn-1',
        'pg-1',
        'pn-2',
        'pg-2',
      ]);
      expect(out[1]?.grapePrimary).toBe('Pinot Grigio');
    });

    it('is a no-op when ambiguous branch metadata is absent', () => {
      const results: RankedResult[] = [
        makeResult('pn-1', 1, { grapePrimary: 'Pinot Noir' }),
        makeResult('pn-2', 2, { grapePrimary: 'Pinot Noir' }),
        makeResult('pg-1', 3, { grapePrimary: 'Pinot Grigio' }),
      ];

      const out = policy.apply(results, makeContext({
        queryClass: 'ambiguous_short_form',
      }));

      expect(out.map((result) => String(result.entityId))).toEqual([
        'pn-1',
        'pn-2',
        'pg-1',
      ]);
    });
  });

  describe('maxResults truncation', () => {
    it('truncates results to maxResults when set', () => {
      const results = makeList(20);
      const out = policy.apply(results, makeContext({ maxResults: 5 }));
      expect(out).toHaveLength(5);
    });

    it('does not truncate when maxResults is not set', () => {
      const results = makeList(15);
      const out = policy.apply(results, makeContext());
      expect(out).toHaveLength(15);
    });

    it('returns all results when maxResults exceeds total count', () => {
      const results = makeList(3);
      const out = policy.apply(results, makeContext({ maxResults: 10 }));
      expect(out).toHaveLength(3);
    });

    it('truncation is applied after diversity reordering', () => {
      // 5 from same producer — diversity demotes 2. With maxResults=3, only the
      // first 3 retained results should appear.
      const results: RankedResult[] = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeResult(`opus-${i}`, i + 1, { producer: 'Opus One' }),
        ),
      ];
      const out = policy.apply(results, makeContext({ maxResults: 3 }));
      // After diversity: [opus-0, opus-1, opus-2, opus-3, opus-4]
      // After truncation to 3: [opus-0, opus-1, opus-2]
      expect(out).toHaveLength(3);
      expect(out.map((r) => String(r.entityId))).toEqual(['opus-0', 'opus-1', 'opus-2']);
    });
  });

  // ── Pipeline integration check ────────────────────────────────────────────

  describe('policy contract invariants', () => {
    it('returned ranks are always 1-based contiguous regardless of operation', () => {
      // Combine diversity + truncation
      const results: RankedResult[] = [
        makeResult('a', 1, { producer: 'P' }),
        makeResult('b', 2, { producer: 'P' }),
        makeResult('c', 3, { producer: 'P' }),
        makeResult('d', 4, { producer: 'P' }), // demoted
        makeResult('e', 5, { producer: 'Other' }),
      ];
      const out = policy.apply(results, makeContext({ maxResults: 4 }));
      expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    });

    it('does not mutate the input array', () => {
      const results = makeList(5, { producer: 'Same' });
      const originalIds = results.map((r) => String(r.entityId));
      policy.apply(results, makeContext());
      // Original array still has original order
      expect(results.map((r) => String(r.entityId))).toEqual(originalIds);
    });
  });
});
