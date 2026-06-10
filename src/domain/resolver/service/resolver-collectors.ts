/**
 * Pure collector helpers for the entity resolver.
 *
 * Extracted from `resolver.ts` (which had grown past 960 LOC): each function
 * here is a PURE transform over anchors / candidates / resolver input (no `this`,
 * no I/O), so it is independently testable and keeps the resolver class focused
 * on the resolve pipeline. Behaviour is unchanged — a mechanical move.
 */

import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { EntityCandidateSource } from '../model/entity-candidate-generator-input.js';
import type { ResolverInput } from '../model/resolver-input.js';
import {
  computeLookupStrategyAdjustment,
  type LookupStrategyAdjustment,
} from './resolver-lookup-strategy.js';

export function collectAnchorLookupVariants(anchors: readonly AnchorCandidate[]): readonly string[] {
  const variants = new Set<string>();
  for (const anchor of anchors) {
    for (const variant of anchor.lookupVariants ?? []) {
      if (variant.length > 0) {
        variants.add(variant);
      }
    }
  }

  return [...variants].sort();
}

export function collectAnchorLookupStrategies(anchors: readonly AnchorCandidate[]): readonly string[] {
  const strategies = new Set<string>();
  for (const anchor of anchors) {
    for (const strategy of anchor.lookupStrategies ?? []) {
      if (strategy.length > 0) {
        strategies.add(strategy);
      }
    }
  }

  return [...strategies].sort();
}

export function collectCandidateSources(
  candidate: Pick<ResolverCandidate, 'source' | 'sources'>,
): readonly EntityCandidateSource[] {
  const combined = new Set<EntityCandidateSource>();
  for (const source of candidate.sources ?? []) {
    combined.add(source);
  }
  if (candidate.source !== undefined) {
    combined.add(candidate.source);
  }
  return [...combined].sort();
}

export function collectBlockerSeedEntityIds(
  candidates: readonly ResolverCandidate[],
): readonly string[] {
  const blockerSeedEntityIds = new Set<string>();
  for (const candidate of candidates) {
    if (collectCandidateSources(candidate).includes('blocker_seed')) {
      blockerSeedEntityIds.add(String(candidate.entityId));
    }
  }

  return [...blockerSeedEntityIds].sort();
}

export function collectCandidateSourceBreakdown(
  candidates: readonly ResolverCandidate[],
): readonly {
  readonly source: EntityCandidateSource;
  readonly entityIds: readonly string[];
  readonly count: number;
}[] {
  const bySource = new Map<EntityCandidateSource, Set<string>>();
  for (const candidate of candidates) {
    for (const source of collectCandidateSources(candidate)) {
      const entityIds = bySource.get(source) ?? new Set<string>();
      entityIds.add(String(candidate.entityId));
      bySource.set(source, entityIds);
    }
  }

  const sourceOrder: readonly EntityCandidateSource[] = [
    'alias',
    'planner_heuristic',
    'entity_lookup',
    'blocker_seed',
  ];

  return sourceOrder
    .filter((source) => bySource.has(source))
    .map((source) => {
      const entityIds = [...(bySource.get(source) ?? new Set<string>())].sort();
      return {
        source,
        entityIds,
        count: entityIds.length,
      };
    });
}

export function collectLookupStrategyAdjustments(
  input: ResolverInput,
): readonly LookupStrategyAdjustment[] {
  const byEntity = new Map<string, Set<string>>();

  for (const anchor of input.anchorCandidates) {
    const strategies = anchor.lookupStrategies ?? [];
    if (strategies.length === 0) {
      continue;
    }

    for (const entityId of anchor.candidateEntityIds) {
      const key = String(entityId);
      const existing = byEntity.get(key) ?? new Set<string>();
      for (const strategy of strategies) {
        if (strategy.length > 0) {
          existing.add(strategy);
        }
      }
      byEntity.set(key, existing);
    }
  }

  return [...byEntity.entries()]
    .map(([entityId, strategies]) => {
      const strategyList = [...strategies].sort();
      const rawScoreDelta = computeLookupStrategyAdjustment(
        strategyList,
        input.queryClass,
      );
      return {
        entityId,
        strategies: strategyList,
        rawScoreDelta,
      };
    })
    .filter((entry) => entry.rawScoreDelta !== 0);
}
