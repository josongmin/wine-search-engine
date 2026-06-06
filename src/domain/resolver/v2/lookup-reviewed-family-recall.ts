import type { NormalizedQueryViews } from '../../query/model/query-views.js';
import { compactForLookup } from '../../query/service/phonetic-skeleton.js';
import {
  buildLookupQuerySemanticProbe,
  type LookupQuerySemanticProbe,
} from './lookup-semantic-scope.js';

export interface LookupReviewedFamilyRecallMatch {
  readonly normalizedSurface: string;
  readonly familyKey: string;
  readonly entityIds: readonly string[];
  readonly recallWeight: number;
  readonly localizedSurfaces?: readonly string[] | undefined;
  readonly witnessSources?: readonly string[] | undefined;
}

export interface LookupReviewedFamilyRecallPort {
  findMatches(args: {
    readonly query: string;
    readonly views: NormalizedQueryViews;
    readonly locale: 'ko' | 'global';
  }): readonly LookupReviewedFamilyRecallMatch[];
}

function queryContainsSurface(
  probe: LookupQuerySemanticProbe,
  normalizedSurface: string,
): boolean {
  const paddedSurface = ` ${normalizedSurface} `;
  if (` ${probe.normalizedQuery} `.includes(paddedSurface)) {
    return true;
  }
  if (
    probe.transliteratedQuery !== undefined
    && ` ${probe.transliteratedQuery} `.includes(paddedSurface)
  ) {
    return true;
  }
  const compactSurface = compactForLookup(normalizedSurface);
  return compactSurface.length > 0 && probe.compactQuery.includes(compactSurface);
}

export function queryMatchesReviewedFamilyRecallSurface(args: {
  readonly probe: LookupQuerySemanticProbe;
  readonly normalizedSurfaces: readonly string[];
}): boolean {
  return args.normalizedSurfaces.some((surface) => queryContainsSurface(args.probe, surface));
}

export function buildReviewedFamilyRecallProbe(args: {
  readonly query: string;
  readonly views: NormalizedQueryViews;
  readonly locale: 'ko' | 'global';
}): LookupQuerySemanticProbe {
  return buildLookupQuerySemanticProbe(args);
}
