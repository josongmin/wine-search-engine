import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type { WineSearchRunInput, WineSearchRunResult } from '../dto/wine-search.dto.js';

export interface WineSearchFacadePort {
  run(
    input: WineSearchRunInput,
    options: CliFacadeRequestOptions,
  ): Promise<WineSearchRunResult>;
}
