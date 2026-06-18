/**
 * Entity Lookup V2 → ResolveResponse projection.
 *
 * Legacy resolve wire shape is validated by mapping-only regression tests.
 * Public exact-entity HTTP is `POST /v2/entity-lookup`.
 * lookup authority without duplicating the resolver pipeline.
 */

import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import { mapLookupV2StatusToWireDecisionStatus } from './entity-lookup-v2-mapping.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { EntityLookupV2UseCasePort } from '../port/search-route-usecases.port.js';
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type { EntityLookupV2Result } from './entity-lookup-v2.dto.js';
import { mapResolveRequestToEntityLookupV2Command } from './entity-lookup-v2-request-mapping.js';
import { buildEntityLookupV2AutocompleteTraceRef } from './entity-lookup-v2-autocomplete-mapping.js';
import { projectV2EvidenceRefs } from './entity-lookup-v2-candidate-projection.js';

/** Compatibility alias — prefer {@link mapLookupV2StatusToWireDecisionStatus}. */
export const mapLookupV2StatusToResolveStatus = mapLookupV2StatusToWireDecisionStatus;

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
  const status = mapLookupV2StatusToWireDecisionStatus(result.status);

  return {
    status,
    candidates: result.candidates.map((candidate) => ({
      entityId: createCanonicalEntityId(candidate.entityId),
      canonicalLabel: candidate.canonicalLabel,
      calibratedScore: candidate.calibratedScore,
      rank: candidate.rank,
      evidenceRefs: projectV2EvidenceRefs(candidate.channelHits),
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
