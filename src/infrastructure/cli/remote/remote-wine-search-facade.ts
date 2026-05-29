import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import type {
  WineSearchRunInput,
  WineSearchRunResult,
} from '../../../application/cli/dto/wine-search.dto.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { WineSearchFacadePort } from '../../../application/cli/port/wine-search-facade.port.js';
import { RemoteHttpClient } from './remote-http-client.js';

function toBody(input: WineSearchRunInput): Record<string, unknown> {
  return {
    query: input.query,
    ...((input.maxSteps !== undefined
      || input.perStepTimeoutMs !== undefined
      || input.agentTimeoutMs !== undefined
      || input.maxTotalTokens !== undefined)
      ? {
          options: {
            ...(input.maxSteps !== undefined ? { max_steps: input.maxSteps } : {}),
            ...(input.perStepTimeoutMs !== undefined
              ? { per_step_timeout_ms: input.perStepTimeoutMs }
              : {}),
            ...(input.agentTimeoutMs !== undefined
              ? { agent_timeout_ms: input.agentTimeoutMs }
              : {}),
            ...(input.maxTotalTokens !== undefined
              ? { max_total_tokens: input.maxTotalTokens }
              : {}),
          },
        }
      : {}),
  };
}

export class RemoteWineSearchFacade implements WineSearchFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async run(
    input: WineSearchRunInput,
    options: CliFacadeRequestOptions,
  ): Promise<WineSearchRunResult> {
    return await this.http.requestJson<WineSearchRunResult>(
      {
        method: 'POST',
        path: '/v1/agent',
        body: toBody(input),
      },
      options,
    );
  }
}
