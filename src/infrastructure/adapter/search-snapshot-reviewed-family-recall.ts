import type { NormalizedQueryViews } from '../../domain/query/model/query-views.js';
import type {
  LookupReviewedFamilyRecallMatch,
  LookupReviewedFamilyRecallPort,
} from '../../domain/resolver/v2/lookup-reviewed-family-recall.js';
import {
  buildReviewedFamilyRecallProbe,
  queryMatchesReviewedFamilyRecallSurface,
} from '../../domain/resolver/v2/lookup-reviewed-family-recall.js';
import type { LookupReviewedFamilyRecallRuntimeEntry } from '../../domain/shared/types/search-snapshot-lookup-semantic-runtime.js';

export class SearchSnapshotReviewedFamilyRecallRegistry implements LookupReviewedFamilyRecallPort {
  constructor(
    private readonly entries: readonly LookupReviewedFamilyRecallRuntimeEntry[],
  ) {}

  findMatches(args: {
    readonly query: string;
    readonly views: NormalizedQueryViews;
    readonly locale: 'ko' | 'global';
  }): readonly LookupReviewedFamilyRecallMatch[] {
    const probe = buildReviewedFamilyRecallProbe(args);
    return this.entries
      .filter((entry) =>
        queryMatchesReviewedFamilyRecallSurface({
          probe,
          normalizedSurfaces: [
            entry.normalizedSurface,
            ...(entry.localizedSurfaces ?? []),
          ],
        }))
      .sort((left, right) =>
        right.recallWeight - left.recallWeight
        || left.entityIds.length - right.entityIds.length
        || left.normalizedSurface.localeCompare(right.normalizedSurface),
      )
      .map((entry) => ({
        normalizedSurface: entry.normalizedSurface,
        familyKey: entry.familyKey,
        entityIds: [...entry.entityIds],
        recallWeight: entry.recallWeight,
        ...(entry.localizedSurfaces !== undefined ? { localizedSurfaces: [...entry.localizedSurfaces] } : {}),
        ...(entry.witnessSources !== undefined ? { witnessSources: [...entry.witnessSources] } : {}),
      }));
  }
}
