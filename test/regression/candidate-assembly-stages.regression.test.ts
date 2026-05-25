/**
 * Regression: candidate-assembly stage decomposition
 *
 * Locks the contract of each file-private stage helper exposed via
 * `__internals` AND the equivalence between the post-refactor public
 * `assemble()` and a manual sequential composition of the helpers.
 *
 * Append-only — DO NOT delete a case here. If a stage's signature
 * changes, add a NEW case rather than mutating an existing one.
 */

import { describe, it, expect } from 'vitest';
import {
  CandidateAssembler,
  __internals,
  type AssemblyPolicy,
} from '../../src/domain/retrieval/service/candidate-assembly.js';
import type { CandidateEnvelope } from '../../src/domain/retrieval/model/candidate-envelope.js';

// ---------------------------------------------------------------------------
// Fixture factory (mirrors src/domain/retrieval/service/__tests__/candidate-assembly.test.ts)
// ---------------------------------------------------------------------------

interface MakeOpts {
  readonly producer?: string;
}

function makeCandidate(
  entityId: string,
  fusionScore: number,
  overrides: Partial<CandidateEnvelope['provenance']> = {},
  opts: MakeOpts = {},
): CandidateEnvelope {
  return {
    entityId,
    provenance: {
      channels: ['sparse_bm25'],
      channelScores: [
        { channel: 'sparse_bm25', rawScore: fusionScore, rank: 1, rrfContribution: fusionScore },
      ],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore,
      ...overrides,
    },
    legacyCandidate: {
      entityId,
      bm25Score: fusionScore,
      semanticScore: 0,
      fusedScore: fusionScore,
      retrievalTrace: { channels: ['sparse'], queryViews: [] },
      ...(opts.producer !== undefined ? { producer: opts.producer } : {}),
    },
  };
}

const baseProtectionPolicy = {
  protectExactMatches: true,
  protectAnchorConditioned: true,
} as const;

// ---------------------------------------------------------------------------
// Stage 1: applyHardFilters
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: applyHardFilters', () => {
  it('drops candidates that failed hard constraints, keeps unconstrained ones', () => {
    const candidates = [
      makeCandidate('keep-1', 0.9),
      makeCandidate('drop-1', 0.8, { failedHardConstraints: ['vintage:2020'] }),
      makeCandidate('keep-2', 0.7, { failedHardConstraints: [] }),
    ];
    const out = __internals.applyHardFilters(candidates);
    const ids = out.map((c) => c.entityId);
    expect(ids).toEqual(['keep-1', 'keep-2']);
  });

  it('preserves candidates with a protectedInclusionReason even if hard constraints failed', () => {
    const candidates = [
      makeCandidate('protected', 0.5, {
        failedHardConstraints: ['region:napa'],
        protectedInclusionReason: 'exact_alias_match',
      }),
      makeCandidate('plain-fail', 0.4, { failedHardConstraints: ['region:napa'] }),
    ];
    const out = __internals.applyHardFilters(candidates);
    expect(out.map((c) => c.entityId)).toEqual(['protected']);
  });

  it('is pure: does not mutate the input array', () => {
    const candidates = [
      makeCandidate('a', 0.9, { failedHardConstraints: ['x'] }),
      makeCandidate('b', 0.8),
    ];
    const snapshot = candidates.slice();
    __internals.applyHardFilters(candidates);
    expect(candidates).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Stage 2: dedupeByEntityIdWithNaNSafeMax
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: dedupeByEntityIdWithNaNSafeMax', () => {
  it('keeps the highest fusionScore per entityId', () => {
    const out = __internals.dedupeByEntityIdWithNaNSafeMax([
      makeCandidate('e1', 0.4),
      makeCandidate('e1', 0.9),
      makeCandidate('e1', 0.6),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provenance.fusionScore).toBe(0.9);
  });

  it('treats NaN scores as -Infinity so a finite score always wins', () => {
    const out = __internals.dedupeByEntityIdWithNaNSafeMax([
      makeCandidate('e1', Number.NaN),
      makeCandidate('e1', 0.1),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provenance.fusionScore).toBe(0.1);
  });

  it('is deterministic on score ties via fusionProfile tiebreaker', () => {
    const a = makeCandidate('e1', 0.5, { fusionProfile: 'aa-profile' });
    const b = makeCandidate('e1', 0.5, { fusionProfile: 'bb-profile' });
    const out1 = __internals.dedupeByEntityIdWithNaNSafeMax([a, b]);
    const out2 = __internals.dedupeByEntityIdWithNaNSafeMax([b, a]);
    expect(out1[0]?.provenance.fusionProfile).toBe(out2[0]?.provenance.fusionProfile);
  });
});

// ---------------------------------------------------------------------------
// Stage 3: sortWithTiebreaker
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: sortWithTiebreaker', () => {
  it('sorts by fusionScore descending', () => {
    const out = __internals.sortWithTiebreaker([
      makeCandidate('e1', 0.3),
      makeCandidate('e2', 0.9),
      makeCandidate('e3', 0.6),
    ]);
    expect(out.map((c) => c.entityId)).toEqual(['e2', 'e3', 'e1']);
  });

  it('breaks score ties by entityId lexicographic order', () => {
    const out = __internals.sortWithTiebreaker([
      makeCandidate('e-z', 0.5),
      makeCandidate('e-a', 0.5),
      makeCandidate('e-m', 0.5),
    ]);
    expect(out.map((c) => c.entityId)).toEqual(['e-a', 'e-m', 'e-z']);
  });

  it('does not mutate the input array (returns new sorted copy)', () => {
    const input = [
      makeCandidate('e1', 0.3),
      makeCandidate('e2', 0.9),
    ];
    const before = input.map((c) => c.entityId);
    __internals.sortWithTiebreaker(input);
    expect(input.map((c) => c.entityId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Stage 4: splitProtectedAndNonProtected
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: splitProtectedAndNonProtected', () => {
  it('separates protected from non-protected; concatenation preserves all candidates', () => {
    const all = [
      makeCandidate('p1', 0.9, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('np1', 0.8),
      makeCandidate('p2', 0.7, { anchorConditioned: true }),
      makeCandidate('np2', 0.6),
    ];
    const { protected_, nonProtected } = __internals.splitProtectedAndNonProtected(
      all,
      baseProtectionPolicy,
    );
    expect(protected_.map((c) => c.entityId)).toEqual(['p1', 'p2']);
    expect(nonProtected.map((c) => c.entityId)).toEqual(['np1', 'np2']);
    // concatenation invariant
    expect([...protected_, ...nonProtected].length).toBe(all.length);
  });

  it('respects protectExactMatches=false (only anchorConditioned protected)', () => {
    const all = [
      makeCandidate('alias', 0.9, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('anchor', 0.8, { anchorConditioned: true }),
    ];
    const { protected_, nonProtected } = __internals.splitProtectedAndNonProtected(all, {
      protectExactMatches: false,
      protectAnchorConditioned: true,
    });
    expect(protected_.map((c) => c.entityId)).toEqual(['anchor']);
    expect(nonProtected.map((c) => c.entityId)).toEqual(['alias']);
  });

  it('with both protection flags false, every candidate is non-protected', () => {
    const all = [
      makeCandidate('alias', 0.9, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('anchor', 0.8, { anchorConditioned: true }),
    ];
    const { protected_, nonProtected } = __internals.splitProtectedAndNonProtected(all, {
      protectExactMatches: false,
      protectAnchorConditioned: false,
    });
    expect(protected_).toHaveLength(0);
    expect(nonProtected).toHaveLength(2);
  });

  it('preserves input order within each output array', () => {
    const all = [
      makeCandidate('n1', 0.9),
      makeCandidate('p1', 0.8, { protectedInclusionReason: 'exact_alias_match' }),
      makeCandidate('n2', 0.7),
      makeCandidate('p2', 0.6, { protectedInclusionReason: 'known_item_lookup' }),
    ];
    const { protected_, nonProtected } = __internals.splitProtectedAndNonProtected(
      all,
      baseProtectionPolicy,
    );
    expect(protected_.map((c) => c.entityId)).toEqual(['p1', 'p2']);
    expect(nonProtected.map((c) => c.entityId)).toEqual(['n1', 'n2']);
  });
});

// ---------------------------------------------------------------------------
// Stage 5a: applyQuotas — channel quota
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: applyQuotas (channel)', () => {
  it('excludes candidates whose channel hit its quota; cappedBy=channelQuota', () => {
    const nonProtected = [
      makeCandidate('bm25-1', 0.9, { channels: ['sparse_bm25'] }),
      makeCandidate('bm25-2', 0.8, { channels: ['sparse_bm25'] }),
      makeCandidate('bm25-3', 0.7, { channels: ['sparse_bm25'] }),
      makeCandidate('dense-1', 0.6, { channels: ['dense_semantic'] }),
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 2 }],
      protectExactMatches: false,
      protectAnchorConditioned: false,
    };
    const { assembled, cappedBy } = __internals.applyQuotas([], nonProtected, policy);
    const ids = assembled.map((c) => c.entityId);
    expect(ids).toEqual(['bm25-1', 'bm25-2', 'dense-1']);
    expect(cappedBy).toBe('channelQuota');
  });

  it('deterministic order: same input ordering yields same admit decisions', () => {
    const nonProtected = [
      makeCandidate('a', 0.9, { channels: ['sparse_bm25'] }),
      makeCandidate('b', 0.9, { channels: ['sparse_bm25'] }),
      makeCandidate('c', 0.9, { channels: ['sparse_bm25'] }),
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 2 }],
      protectExactMatches: false,
      protectAnchorConditioned: false,
    };
    const r1 = __internals.applyQuotas([], nonProtected, policy);
    const r2 = __internals.applyQuotas([], nonProtected, policy);
    expect(r1.assembled.map((c) => c.entityId)).toEqual(r2.assembled.map((c) => c.entityId));
  });
});

// ---------------------------------------------------------------------------
// Stage 5b: applyQuotas — producer quota
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: applyQuotas (producer)', () => {
  it('excludes max+1th candidate from the same producer; cappedBy=producerSlot', () => {
    const nonProtected = [
      makeCandidate('w1', 0.9, {}, { producer: 'Chateau X' }),
      makeCandidate('w2', 0.8, {}, { producer: 'Chateau X' }),
      makeCandidate('w3', 0.7, {}, { producer: 'Chateau X' }), // over cap
      makeCandidate('w4', 0.6, {}, { producer: 'Domaine Y' }),
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      maxProducerSlots: 2,
      protectExactMatches: false,
      protectAnchorConditioned: false,
    };
    const { assembled, cappedBy } = __internals.applyQuotas([], nonProtected, policy);
    expect(assembled.map((c) => c.entityId)).toEqual(['w1', 'w2', 'w4']);
    expect(cappedBy).toBe('producerSlot');
  });

  it('candidates without a producer bypass the cap (no metadata != penalize)', () => {
    const nonProtected = [
      makeCandidate('w1', 0.9, {}, { producer: 'Chateau X' }),
      makeCandidate('w2', 0.8, {}, { producer: 'Chateau X' }),
      makeCandidate('w3', 0.7), // no producer
      makeCandidate('w4', 0.6), // no producer
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      maxProducerSlots: 2,
      protectExactMatches: false,
      protectAnchorConditioned: false,
    };
    const { assembled } = __internals.applyQuotas([], nonProtected, policy);
    expect(assembled).toHaveLength(4);
  });

  it('protected base seeds producer counts so they count against non-protected cap', () => {
    const protectedBase = [
      makeCandidate('p1', 0.9, { protectedInclusionReason: 'exact_alias_match' }, {
        producer: 'Chateau X',
      }),
      makeCandidate('p2', 0.85, { protectedInclusionReason: 'exact_alias_match' }, {
        producer: 'Chateau X',
      }),
    ];
    const nonProtected = [
      // Would normally be admitted, but Chateau X already has 2 slots used
      makeCandidate('np1', 0.5, {}, { producer: 'Chateau X' }),
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      maxProducerSlots: 2,
      protectExactMatches: true,
      protectAnchorConditioned: false,
    };
    const { assembled, cappedBy } = __internals.applyQuotas(protectedBase, nonProtected, policy);
    expect(assembled.map((c) => c.entityId)).toEqual(['p1', 'p2']);
    expect(cappedBy).toBe('producerSlot');
  });
});

// ---------------------------------------------------------------------------
// Stage 5c: applyQuotas — first-wins cappedBy
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: applyQuotas (cappedBy first-wins)', () => {
  it('records the first cap reason and does not overwrite with a later one', () => {
    // Set up: channelQuota will trigger first (rank 1 violates),
    // producerSlot would also trigger later — first-wins keeps channelQuota.
    const nonProtected = [
      makeCandidate('a', 0.9, { channels: ['sparse_bm25'] }, { producer: 'Chateau X' }),
      makeCandidate('b', 0.8, { channels: ['sparse_bm25'] }, { producer: 'Chateau X' }), // channel blocked
      makeCandidate('c', 0.7, { channels: ['dense_semantic'] }, { producer: 'Chateau X' }), // producer blocked
    ];
    const policy: AssemblyPolicy = {
      maxTotal: 10,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 1 }],
      maxProducerSlots: 1,
      protectExactMatches: false,
      protectAnchorConditioned: false,
    };
    const { cappedBy } = __internals.applyQuotas([], nonProtected, policy);
    expect(cappedBy).toBe('channelQuota');
  });
});

// ---------------------------------------------------------------------------
// Full composition equivalence: assemble() == manual stage pipeline
// ---------------------------------------------------------------------------

describe('candidate-assembly-stages: full composition equivalence', () => {
  const assembler = new CandidateAssembler();

  /** Reference pipeline that reproduces the old monolithic algorithm. */
  function manualAssemble(
    candidates: readonly CandidateEnvelope[],
    policy: AssemblyPolicy,
  ): readonly CandidateEnvelope[] {
    const filtered = __internals.applyHardFilters(candidates);
    const deduped = __internals.dedupeByEntityIdWithNaNSafeMax(filtered);
    const sorted = __internals.sortWithTiebreaker(deduped);
    const { protected_, nonProtected } = __internals.splitProtectedAndNonProtected(sorted, policy);
    const { assembled } = __internals.applyQuotas(protected_, nonProtected, policy);
    return __internals.sortWithTiebreaker(assembled);
  }

  const policies: readonly AssemblyPolicy[] = [
    {
      maxTotal: 10,
      protectExactMatches: true,
      protectAnchorConditioned: true,
    },
    {
      maxTotal: 3,
      protectExactMatches: false,
      protectAnchorConditioned: false,
    },
    {
      maxTotal: 10,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 2 }],
      protectExactMatches: false,
      protectAnchorConditioned: false,
    },
    {
      maxTotal: 10,
      maxProducerSlots: 2,
      protectExactMatches: true,
      protectAnchorConditioned: false,
    },
    {
      maxTotal: 4,
      channelQuotas: [{ channel: 'sparse_bm25', maxSlots: 3 }],
      maxProducerSlots: 2,
      protectExactMatches: true,
      protectAnchorConditioned: true,
    },
  ];

  const inputs: ReadonlyArray<readonly CandidateEnvelope[]> = [
    // empty
    [],
    // single
    [makeCandidate('only', 0.5)],
    // dup + score variation
    [
      makeCandidate('e1', 0.9),
      makeCandidate('e1', 0.4),
      makeCandidate('e2', 0.7),
      makeCandidate('e3', 0.7, {}, { producer: 'X' }),
    ],
    // hard-failed + protected mix
    [
      makeCandidate('drop', 0.95, { failedHardConstraints: ['v'] }),
      makeCandidate('keep-protected', 0.5, {
        failedHardConstraints: ['v'],
        protectedInclusionReason: 'exact_alias_match',
      }),
      makeCandidate('plain', 0.6),
    ],
    // multi-channel + producer
    [
      makeCandidate('a', 0.9, { channels: ['sparse_bm25'] }, { producer: 'Chateau X' }),
      makeCandidate('b', 0.85, { channels: ['sparse_bm25'] }, { producer: 'Chateau X' }),
      makeCandidate('c', 0.8, { channels: ['sparse_bm25'] }, { producer: 'Chateau X' }),
      makeCandidate('d', 0.75, { channels: ['dense_semantic'] }, { producer: 'Domaine Y' }),
      makeCandidate('e', 0.7, { channels: ['dense_semantic'] }, { producer: 'Domaine Y' }),
      makeCandidate('f', 0.65, { channels: ['dense_semantic'] }, { producer: 'Domaine Z' }),
    ],
  ];

  for (let pi = 0; pi < policies.length; pi++) {
    for (let ii = 0; ii < inputs.length; ii++) {
      const policy = policies[pi];
      const input = inputs[ii];
      if (policy === undefined || input === undefined) continue;
      it(`assemble() matches manual pipeline (policy[${pi}], input[${ii}])`, () => {
        const fromPublic = assembler.assemble(input, policy).candidates;
        const fromManual = manualAssemble(input, policy);
        expect(fromPublic.map((c) => c.entityId)).toEqual(fromManual.map((c) => c.entityId));
        expect(fromPublic.map((c) => c.provenance.fusionScore)).toEqual(
          fromManual.map((c) => c.provenance.fusionScore),
        );
      });
    }
  }
});
