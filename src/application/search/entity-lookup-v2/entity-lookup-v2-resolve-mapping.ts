/**
 * Entity Lookup V2 → ResolveResponse projection.
 *
 * `POST /v1/entity/resolve` is an internal regression/tooling surface; the
 * public exact-entity path is `POST /v2/entity-lookup`. This adapter keeps
 * resolve-only callers on the V2 lookup authority without duplicating the
 * resolver pipeline.
 */

import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../../domain/shared/types/index.js';
import type { LookupV2Status } from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { EntityLookupV2UseCasePort } from '../port/search-route-usecases.port.js';
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type { EntityLookupV2Result } from './entity-lookup-v2.dto.js';
import { mapResolveRequestToEntityLookupV2Command } from './entity-lookup-v2-request-mapping.js';
import { buildEntityLookupV2AutocompleteTraceRef } from './entity-lookup-v2-autocomplete-mapping.js';

export function mapLookupV2StatusToResolveStatus(status: LookupV2Status): DecisionStatus {
  switch (status) {
    case 'resolved':
      return 'resolved';
    case 'ambiguous':
      return 'ambiguous';
    case 'redirect_discovery':
    case 'failed':
    default:
      return 'failed';
  }
}

export async function executeResolveViaEntityLookupV2(
  entityLookupV2UseCase: EntityLookupV2UseCasePort,
  request: ResolveRequest,
  options?: RequestExecutionContext,
): Promise<ResolveResponse> {
  const command = mapResolveRequestToEntityLookupV2Command(request);
  const lookupResult = await entityLookupV2UseCase.execute(command, options);
  return mapEntityLookupV2ResultToResolveResponse(lookupResult, request);
}

export function mapEntityLookupV2ResultToResolveResponse(
  result: EntityLookupV2Result,
  request: ResolveRequest,
): ResolveResponse {
  const traceRef = buildEntityLookupV2AutocompleteTraceRef(result);
  const status = mapLookupV2StatusToResolveStatus(result.status);

  return {
    status,
    candidates: result.candidates.map((candidate) => ({
      entityId: createCanonicalEntityId(candidate.entityId),
      canonicalLabel: candidate.canonicalLabel,
      calibratedScore: candidate.calibratedScore,
      rank: candidate.rank,
      evidenceRefs: [],
    })),
    topEntity: result.topCandidate !== null
      ? {
          entityId: createCanonicalEntityId(result.topCandidate.entityId),
          canonicalLabel: result.topCandidate.canonicalLabel,
          calibratedScore: result.topCandidate.calibratedScore,
        }
      : undefined,
    decision_trace_ref: traceRef,
    authority_trace_ref: traceRef,
    ...(request.requestId !== undefined ? { request_id: request.requestId } : {}),
  };
}
