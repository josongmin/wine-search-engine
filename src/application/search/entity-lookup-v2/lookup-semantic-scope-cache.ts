import type { NormalizedQueryViews } from '../../../domain/query/model/query-views.js';
import {
  resolveLookupSemanticLocale,
  type LookupSemanticScopeRegistryPort,
} from '../../../domain/resolver/v2/lookup-semantic-scope.js';

export interface LookupSemanticScopeMatch {
  readonly entityId: string;
}

/**
 * One semantic-scope registry scan per request; shared by candidate seeding and
 * finishResult scope-target authority.
 */
export function collectLookupSemanticScopeMatches(args: {
  readonly registry: LookupSemanticScopeRegistryPort;
  readonly rawQuery: string;
  readonly views: NormalizedQueryViews;
  readonly locale: string | undefined;
}): readonly LookupSemanticScopeMatch[] {
  const semanticScopeLocale = resolveLookupSemanticLocale({
    query: args.rawQuery,
    locale: args.locale,
  });
  return args.registry.findMatches({
    query: args.rawQuery,
    views: args.views,
    locale: semanticScopeLocale,
  });
}
