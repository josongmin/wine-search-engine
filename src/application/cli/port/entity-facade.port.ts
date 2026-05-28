import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  EntityAutocompleteInput,
  EntityAutocompleteResult,
  EntityResolveInput,
  EntityResolveResult,
} from '../dto/entity.dto.js';

export interface EntityFacadePort {
  resolve(
    input: EntityResolveInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityResolveResult>;
  autocomplete(
    input: EntityAutocompleteInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityAutocompleteResult>;
}
