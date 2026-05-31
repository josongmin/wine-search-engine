import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  PrimitiveSearchInput,
  PrimitiveSearchResult,
} from '../dto/search.dto.js';

export interface SearchFacadePort {
  hybrid(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
  semantic(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
  lexical(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
  lookupWine(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
}
