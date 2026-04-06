/**
 * SearchResponseCachePort — Domain port for search response caching.
 *
 * This is the capability used by the search application to read and write
 * fully assembled search responses with freshness checks.
 */

import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { SearchResponseV1 } from '../../response/model/search-response.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { CacheResult } from '../model/cache-result.js';
import type { CacheReadRuntimeState } from '../../cache/cache-policy.js';

export interface SearchResponseCachePort {
  getSearchResponse(
    plan: QueryPlanV1,
    request: {
      readonly sessionContext?: { readonly sessionId: string };
      readonly context?: { readonly locale: string };
    },
    currentSnapshot: DecisionSnapshot,
    runtimeState?: CacheReadRuntimeState,
  ): Promise<CacheResult<SearchResponseV1>>;

  setSearchResponse(
    plan: QueryPlanV1,
    request: {
      readonly sessionContext?: { readonly sessionId: string };
      readonly context?: { readonly locale: string };
    },
    response: SearchResponseV1,
  ): Promise<boolean>;
}
