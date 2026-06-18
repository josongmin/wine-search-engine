import type { AnchorCandidate } from '../../../domain/query/model/anchor-candidate.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import {
  findRawQueryExactSafeSingletonAliasWitness,
  hasDeterministicSingletonAliasWitness,
} from '../../../domain/query/service/exact-safe-anchor-witness.js';
import { hasHighConfidenceStrictExactSingletonAnchor } from './entity-lookup-v2-decision-helpers.js';

/** Single per-request witness evaluation reused across lookup stages. */
export interface LookupWitnessSnapshot {
  readonly exactSafeSingletonWitness: ReturnType<typeof findRawQueryExactSafeSingletonAliasWitness>;
  readonly hasDeterministicSingleton: boolean;
  readonly hasHighConfidenceStrictExactSingleton: boolean;
}

export function buildLookupWitnessSnapshot(args: {
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly anchors: readonly AnchorCandidate[];
}): LookupWitnessSnapshot {
  const exactSafeSingletonWitness = findRawQueryExactSafeSingletonAliasWitness(
    args.rawQuery,
    args.normalizedQuery,
    args.anchors,
  );
  return {
    exactSafeSingletonWitness,
    hasDeterministicSingleton: hasDeterministicSingletonAliasWitness(args.anchors),
    hasHighConfidenceStrictExactSingleton: hasHighConfidenceStrictExactSingletonAnchor(args.anchors),
  };
}

export function shouldSurfacePersistedAmbiguityEarly(
  witness: LookupWitnessSnapshot,
  persistedAmbiguity: unknown,
): persistedAmbiguity is NonNullable<typeof persistedAmbiguity> {
  return persistedAmbiguity != null
    && witness.exactSafeSingletonWitness === undefined
    && !witness.hasDeterministicSingleton
    && !witness.hasHighConfidenceStrictExactSingleton;
}

export type LookupPoolNarrowingWitnessEntityId = CanonicalEntityId | undefined;
