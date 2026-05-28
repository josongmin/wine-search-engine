import type { WineSearchFacadePort } from '../../../application/cli/port/wine-search-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  WineSearchRunInput,
  WineSearchRunResult,
} from '../../../application/cli/dto/wine-search.dto.js';
import { CliError } from '../../../application/cli/command/cli-error.js';
import { mapWineSearchResultToResponse } from '../../../interface/http/routes/wine-search-response-mapper.js';
import { LocalContainerRuntime } from './local-container-runtime.js';

export class LocalWineSearchFacade implements WineSearchFacadePort {
  constructor(
    private readonly runtime: Pick<LocalContainerRuntime, 'withContainer'> = new LocalContainerRuntime(),
  ) {}

  async run(input: WineSearchRunInput, options: CliFacadeRequestOptions): Promise<WineSearchRunResult> {
    return await this.runtime.withContainer(async (container) => {
      const orchestrator = container.wineSearch?.wineSearchOrchestrator;
      if (orchestrator === undefined) {
        throw CliError.execution(
          'Local wine-search is unavailable: WINE_SEARCH_ENABLED/Anthropic wiring is not active.',
        );
      }
      const result = await orchestrator.execute({
        query: input.query,
        requestId: options.requestId,
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        ...(input.perStepTimeoutMs !== undefined
          ? { perStepTimeoutMs: input.perStepTimeoutMs }
          : {}),
        ...(input.agentTimeoutMs !== undefined
          ? { agentTimeoutMs: input.agentTimeoutMs }
          : {}),
        ...(input.maxTotalTokens !== undefined
          ? { maxTotalTokens: input.maxTotalTokens }
          : {}),
        ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      });
      return mapWineSearchResultToResponse(result, options.requestId);
    });
  }
}
