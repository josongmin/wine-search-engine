import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import type { ResolveRequest } from './resolve-request.dto.js';
import type { AutocompleteResponse } from './autocomplete-response.dto.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import type { LookupResolverProjectionPort } from './port/search-pipeline-deps.port.js';
import type { EntityLookupV2UseCasePort } from './port/search-route-usecases.port.js';
import {
  mapEntityLookupV2ResultToAutocompleteResponse,
  mapResolveRequestToEntityLookupV2Command,
  type AutocompleteHydrationDocument,
} from './entity-lookup-v2/entity-lookup-v2-autocomplete-mapping.js';

export interface AutocompleteQueryRunnerDeps {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
}

export interface AutocompleteQueryRunner {
  execute(
    request: ResolveRequest,
    options?: RequestExecutionContext,
  ): Promise<AutocompleteResponse>;
}

async function hydrateAutocompleteDocuments(
  deps: AutocompleteQueryRunnerDeps,
  candidateIds: readonly CanonicalEntityId[],
): Promise<ReadonlyMap<string, AutocompleteHydrationDocument>> {
  if (candidateIds.length === 0) {
    return new Map();
  }

  const projections = await deps.resolverProjectionLookup.getResolverProjections(candidateIds);
  const docs = new Map<string, AutocompleteHydrationDocument>();
  for (const [entityId, projection] of projections) {
    docs.set(String(entityId), projection);
  }
  return docs;
}

/**
 * Eval/integration-only autocomplete rail — Entity Lookup V2 authority with
 * resolver projection hydration. No live HTTP route or production Container port.
 */
export async function runAutocompleteQuery(
  deps: AutocompleteQueryRunnerDeps,
  request: ResolveRequest,
  options?: RequestExecutionContext,
): Promise<AutocompleteResponse> {
  const command = mapResolveRequestToEntityLookupV2Command(request);
  const lookupResult = await deps.entityLookupV2UseCase.execute(command, options);
  const candidateIds = lookupResult.candidates.map((candidate) =>
    createCanonicalEntityId(candidate.entityId),
  );
  const docs = await hydrateAutocompleteDocuments(deps, candidateIds);

  return mapEntityLookupV2ResultToAutocompleteResponse(lookupResult, docs);
}

export function buildAutocompleteQueryRunner(deps: AutocompleteQueryRunnerDeps): AutocompleteQueryRunner {
  return {
    execute: (request, options) => runAutocompleteQuery(deps, request, options),
  };
}
