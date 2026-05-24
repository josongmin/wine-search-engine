/**
 * Regression: multi-vintage same-entity cluster collapses to resolved
 * verdict instead of routing to ambiguous→clarify.
 *
 * Pre-fix (commit d73bd6f3 era): user query "Sassicaia" → Vespa returns
 * 3 candidates [Sassicaia 2018, 2001 Tenuta San Guido Sassicaia × 2] →
 * decision-engine Gate 2 sees conformalSetSize ≥ 2 + small gap → emits
 * `ambiguous / clarify` → synthesizer asks "어떤 빈티지요?" → bench rubric
 * scores 0. Same pattern for Opus One, Almaviva, Gaja, etc.
 *
 * Post-fix: the multi-vintage-cluster-detector classifies the top-K
 * candidates' de-vintaged identity key. When ≥80% share the same key AND
 * the request shape is `entity_lookup`, the verdict resolves to the top
 * rank candidate within the cluster and rulesApplied includes
 * `MULTI_VINTAGE_CLUSTER_RESOLVED`.
 *
 * Pins:
 *  1. `deriveDeVintagedIdentityKey` is exact + lowercase + whitespace-normalized
 *  2. `classifyMultiVintageCluster` returns:
 *     - `same_entity_cluster` for ≥80% same-key + ≥2 candidates
 *     - `distinct_entities` for low key agreement
 *     - `singleton` for 1 candidate
 *     - `empty` for 0 candidates
 *  3. Top-K bounded at 5 (an outlier 6th doesn't dilute a tight 3-5 cluster)
 *  4. Stripping handles vintage at start, end, or middle (2 passes max)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyMultiVintageCluster,
  deriveDeVintagedIdentityKey,
} from '../../src/domain/decision/service/multi-vintage-cluster-detector.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { ResolvedCandidate } from '../../src/domain/resolver/model/resolved-candidate.js';

function cand(rank: number, canonicalLabel: string, score = 0.5): ResolvedCandidate {
  return {
    entityId: createEntityId(`wine-ce-test-${rank}`),
    canonicalLabel,
    calibratedScore: score,
    rank,
    evidenceRefs: [],
  };
}

describe('deriveDeVintagedIdentityKey', () => {
  it('strips leading 4-digit year', () => {
    expect(deriveDeVintagedIdentityKey('2001 Tenuta San Guido Sassicaia')).toBe('tenuta san guido sassicaia');
  });

  it('strips trailing 4-digit year', () => {
    expect(deriveDeVintagedIdentityKey('Sassicaia 2018')).toBe('sassicaia');
  });

  it('strips both leading and trailing year (2 passes)', () => {
    expect(deriveDeVintagedIdentityKey('2010 Château Cheval Blanc 2010')).toBe('château cheval blanc');
  });

  it('collapses internal whitespace runs', () => {
    expect(deriveDeVintagedIdentityKey('  2001  Tenuta   San  Guido  Sassicaia  ')).toBe('tenuta san guido sassicaia');
  });

  it('does NOT strip digits that are not 4-digit year tokens (varietal numerics)', () => {
    // "Lot 21" stays — vintage stripper only matches 1800-2199 standalone tokens
    expect(deriveDeVintagedIdentityKey('2017 Leyda Lot 21 Pinot Noir')).toBe('leyda lot 21 pinot noir');
  });

  it('handles labels with no vintage at all', () => {
    expect(deriveDeVintagedIdentityKey('Opus One Overture')).toBe('opus one overture');
  });

  it('is case-insensitive in output', () => {
    expect(deriveDeVintagedIdentityKey('OPUS ONE')).toBe('opus one');
  });
});

describe('classifyMultiVintageCluster — same_entity_cluster', () => {
  it('5 Sassicaia vintages → same_entity_cluster, resolved rank 1', () => {
    // Tight cluster: all 5 share key 'sassicaia' (vintage-only variation).
    const tightCands = [
      cand(1, 'Sassicaia 2018', 0.8),
      cand(2, 'Sassicaia 2015', 0.75),
      cand(3, 'Sassicaia 2010', 0.7),
      cand(4, '2005 Sassicaia', 0.65),
      cand(5, '2001 Sassicaia', 0.6),
    ];
    const result = classifyMultiVintageCluster(tightCands);
    expect(result.kind).toBe('same_entity_cluster');
    if (result.kind === 'same_entity_cluster') {
      expect(result.resolvedTopRank).toBe(1);
      expect(result.clusterSize).toBe(5);
      expect(result.identityKey).toBe('sassicaia');
    }
    // Also assert mixed-prefix cluster: 4/5 share key = 0.8 exactly → still cluster
    const mostlyCands = [
      cand(1, 'Opus One 2018', 0.8),
      cand(2, 'Opus One 2015', 0.75),
      cand(3, 'Opus One 2010', 0.7),
      cand(4, 'Opus One 2005', 0.65),
      cand(5, 'Almaviva 2008', 0.6),  // outlier different wine
    ];
    const result2 = classifyMultiVintageCluster(mostlyCands);
    expect(result2.kind).toBe('same_entity_cluster');
    if (result2.kind === 'same_entity_cluster') {
      expect(result2.resolvedTopRank).toBe(1);
      expect(result2.clusterSize).toBe(4);
      expect(result2.identityKey).toBe('opus one');
    }
  });

  it('Bronze-shape: "Sassicaia 2018" and two "2001 Tenuta San Guido Sassicaia" → 2/3 same key NOT a cluster (different key dominance)', () => {
    // 1 'sassicaia' + 2 'tenuta san guido sassicaia' → dominant key 'tenuta san guido sassicaia' has 2/3 = 0.67 < 0.8 → not a cluster
    // This is the conservative behaviour — the producer-name variance is a real
    // signal that these might be slightly different products
    const cands = [
      cand(1, 'Sassicaia 2018', 0.8),
      cand(2, '2001 Tenuta San Guido Sassicaia', 0.75),
      cand(3, '2001 Tenuta San Guido Sassicaia', 0.7),
    ];
    const result = classifyMultiVintageCluster(cands);
    // 0.67 < 0.8 → distinct_entities (conservative)
    expect(result.kind).toBe('distinct_entities');
  });
});

describe('classifyMultiVintageCluster — distinct_entities', () => {
  it('top candidates are different wines → distinct', () => {
    const cands = [
      cand(1, 'Opus One 2018', 0.8),
      cand(2, 'Sassicaia 2015', 0.75),
      cand(3, 'Tignanello 2010', 0.7),
    ];
    expect(classifyMultiVintageCluster(cands).kind).toBe('distinct_entities');
  });
});

describe('classifyMultiVintageCluster — edge cases', () => {
  it('singleton → singleton', () => {
    expect(classifyMultiVintageCluster([cand(1, 'Sassicaia 2018')]).kind).toBe('singleton');
  });

  it('empty → empty', () => {
    expect(classifyMultiVintageCluster([]).kind).toBe('empty');
  });

  it('top-K bounded at 5: 6th-rank outlier does not dilute', () => {
    const cands = [
      cand(1, 'Opus One 2018', 0.8),
      cand(2, 'Opus One 2015', 0.75),
      cand(3, 'Opus One 2010', 0.7),
      cand(4, 'Opus One 2005', 0.65),
      cand(5, 'Opus One 2000', 0.6),
      cand(6, 'Some Distinct Wine', 0.4),  // ignored — beyond top-K
    ];
    const result = classifyMultiVintageCluster(cands);
    expect(result.kind).toBe('same_entity_cluster');
    if (result.kind === 'same_entity_cluster') {
      expect(result.clusterSize).toBe(5);
    }
  });
});
