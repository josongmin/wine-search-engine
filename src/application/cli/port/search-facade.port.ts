import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  SearchHybridInput,
  SearchHybridResult,
  SearchRunInput,
  SearchRunResult,
} from '../dto/search.dto.js';

export interface SearchFacadePort {
  run(input: SearchRunInput, options: CliFacadeRequestOptions): Promise<SearchRunResult>;
  hybrid(input: SearchHybridInput, options: CliFacadeRequestOptions): Promise<SearchHybridResult>;
}
