import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  PrimitiveSearchInput,
  PrimitiveSearchResult,
} from '../dto/search.dto.js';

// Discovery primitives only. Lookup moved to the dedicated LookupFacadePort in
// the V2-only cutover (lookup is identity resolution, not discovery search).
export interface SearchFacadePort {
  hybrid(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
  semantic(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
  lexical(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult>;
}
