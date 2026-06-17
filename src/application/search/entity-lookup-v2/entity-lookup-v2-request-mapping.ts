/**
 * ResolveRequest → EntityLookupV2Command projection (shared by autocomplete,
 * resolve delegate, and internal tooling).
 */

import type { ResolveRequest } from '../resolve-request.dto.js';
import type { EntityLookupV2Command } from './entity-lookup-v2.dto.js';

/** Default candidate window for typeahead / resolve surfaces — mirrors HTTP schema default (10). */
export const LOOKUP_V2_DEFAULT_MAX_CANDIDATES = 10;

export function mapResolveRequestToEntityLookupV2Command(request: ResolveRequest): EntityLookupV2Command {
  return {
    query: request.query,
    maxCandidates: request.queryBudget?.maxCandidates ?? LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
    mode: 'default',
    ...(request.context?.locale !== undefined ? { locale: request.context.locale } : {}),
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
  };
}
