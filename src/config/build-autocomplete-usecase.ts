import { AutocompleteUseCase } from '../application/search/autocomplete.usecase.js';
import type { LookupResolverProjectionPort } from '../application/search/port/search-pipeline-deps.port.js';
import type {
  AutocompleteUseCasePort,
  EntityLookupV2UseCasePort,
} from '../application/search/port/search-route-usecases.port.js';

export interface AutocompleteUseCaseFactoryDeps {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
}

/**
 * Eval / integration-only autocomplete wiring. Not part of the production
 * `Container` — the use case has no live HTTP surface after the V2 cutover.
 */
export function buildAutocompleteUseCase(deps: AutocompleteUseCaseFactoryDeps): AutocompleteUseCasePort {
  return new AutocompleteUseCase(deps);
}
