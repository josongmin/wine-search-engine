import type { NormalizedQueryViews } from '../../domain/query/model/query-views.js';
import {
  buildLookupQuerySemanticProbe,
  queryMatchesLookupSemanticScope,
  type LookupSemanticScopeMatch,
  type LookupSemanticScopeRegistryPort,
  type LookupSemanticScopeSurfaceIndex,
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
  private readonly reviewedTargetEntityIds: ReadonlySet<string>;
  private readonly surfaceIndex: LookupSemanticScopeSurfaceIndex | undefined;

  constructor(
    private readonly entries: readonly LookupSemanticScopeRuntimeEntry[],
    // Reviewed component-surface index (final architecture L1). Optional and
    // purely additive: when absent the matcher falls back to latin-literal
    // token matching exactly as before (zero regression).
    componentSurfaces?: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    // Every runtime scope entry is a reviewed approved target (rejected rows
    // never reach the runtime artifact), so the anchor set is just their ids.
    this.reviewedTargetEntityIds = new Set(entries.map((entry) => entry.entityId));
    this.surfaceIndex = componentSurfaces !== undefined ? { componentSurfaces } : undefined;
  }

  getReviewedTargetEntityIds(): ReadonlySet<string> {
    return this.reviewedTargetEntityIds;
  }

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
          ...(this.surfaceIndex !== undefined ? { surfaceIndex: this.surfaceIndex } : {}),
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
