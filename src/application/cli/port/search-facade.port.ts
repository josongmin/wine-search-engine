import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  SearchRunInput,
  SearchRunResult,
} from '../dto/search.dto.js';

export interface SearchFacadePort {
  run(input: SearchRunInput, options: CliFacadeRequestOptions): Promise<SearchRunResult>;
}
