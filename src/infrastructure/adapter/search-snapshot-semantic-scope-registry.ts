import type { NormalizedQueryViews } from '../../domain/query/model/query-views.js';
import {
  buildLookupQuerySemanticProbe,
  queryMatchesLookupSemanticScope,
  type LookupSemanticScopeMatch,
  type LookupSemanticScopeRegistryPort,
} from '../../domain/resolver/v2/lookup-semantic-scope.js';
import type { LookupSemanticScopeRuntimeEntry } from '../../domain/shared/types/search-snapshot-lookup-semantic-runtime.js';

function specificityScore(entry: LookupSemanticScopeRuntimeEntry): number {
  return (
    (entry.scopeAxis === 'line' ? 100 : 0)
    + (entry.lineKey !== undefined ? 10 : 0)
    + (entry.regionKey !== undefined ? 4 : 0)
    + (entry.appellationKey !== undefined ? 4 : 0)
    + (entry.vintage !== undefined ? 8 : 0)
    + (entry.surfaceFormKind === 'mixed_script' ? 2 : 0)
    + (entry.surfaceFormKind === 'compact' ? 1 : 0)
  );
}

export class SearchSnapshotSemanticScopeRegistry implements LookupSemanticScopeRegistryPort {
  constructor(
    private readonly entries: readonly LookupSemanticScopeRuntimeEntry[],
  ) {}

  findMatches(args: {
    readonly query: string;
    readonly views: NormalizedQueryViews;
    readonly locale: 'ko' | 'global';
  }): readonly LookupSemanticScopeMatch[] {
    const probe = buildLookupQuerySemanticProbe({
      query: args.query,
      views: args.views,
      locale: args.locale,
    });
    return this.entries
      .filter((entry) =>
        entry.locale === args.locale
        && queryMatchesLookupSemanticScope({
          probe,
          scope: {
            scopeAxis: entry.scopeAxis,
            familyKey: entry.familyKey,
            ...(entry.lineKey !== undefined ? { lineKey: entry.lineKey } : {}),
            ...(entry.regionKey !== undefined ? { regionKey: entry.regionKey } : {}),
            ...(entry.appellationKey !== undefined ? { appellationKey: entry.appellationKey } : {}),
            ...(entry.vintage !== undefined ? { vintage: entry.vintage } : {}),
            surfaceFormKind: entry.surfaceFormKind,
            locale: entry.locale,
          },
        })
      )
      .sort((left, right) =>
        specificityScore(right) - specificityScore(left)
        || left.semanticScopeKey.localeCompare(right.semanticScopeKey),
      )
      .map((entry) => ({
        semanticScopeKey: entry.semanticScopeKey,
        scopeAxis: entry.scopeAxis,
        familyKey: entry.familyKey,
        ...(entry.lineKey !== undefined ? { lineKey: entry.lineKey } : {}),
        ...(entry.regionKey !== undefined ? { regionKey: entry.regionKey } : {}),
        ...(entry.appellationKey !== undefined ? { appellationKey: entry.appellationKey } : {}),
        ...(entry.vintage !== undefined ? { vintage: entry.vintage } : {}),
        surfaceFormKind: entry.surfaceFormKind,
        locale: entry.locale,
        entityId: entry.entityId,
      }));
  }
}
