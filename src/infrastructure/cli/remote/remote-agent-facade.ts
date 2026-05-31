import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentSessionStartInput,
  AgentSessionStartResult,
  AgentSessionTurnInput,
  AgentSessionTurnResult,
} from '../../../application/cli/dto/agent.dto.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { AgentFacadePort } from '../../../application/cli/port/agent-facade.port.js';
import { RemoteHttpClient } from './remote-http-client.js';

function toAgentOptions(options: AgentRunInput['options']): Record<string, unknown> | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...(options.maxSteps !== undefined ? { max_steps: options.maxSteps } : {}),
    ...(options.perStepTimeoutMs !== undefined ? { per_step_timeout_ms: options.perStepTimeoutMs } : {}),
    ...(options.agentTimeoutMs !== undefined ? { agent_timeout_ms: options.agentTimeoutMs } : {}),
    ...(options.maxTotalTokens !== undefined ? { max_total_tokens: options.maxTotalTokens } : {}),
  };
}

function toAgentRunBody(input: AgentRunInput): Record<string, unknown> {
  return {
    messages: input.messages,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(toAgentOptions(input.options) !== undefined ? { options: toAgentOptions(input.options) } : {}),
  };
}

function toAgentSessionStartBody(input: AgentSessionStartInput): Record<string, unknown> {
  return {
    ...(input.clientSessionId !== undefined ? { client_session_id: input.clientSessionId } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(toAgentOptions(input.options) !== undefined ? { options: toAgentOptions(input.options) } : {}),
  };
}

function toAgentSessionTurnBody(input: AgentSessionTurnInput): Record<string, unknown> {
  return {
    client_turn_id: input.clientTurnId,
    messages: input.messages,
    ...(toAgentOptions(input.options) !== undefined ? { options: toAgentOptions(input.options) } : {}),
    ...(input.expectedSessionVersion !== undefined
      ? { expected_session_version: input.expectedSessionVersion }
      : {}),
  };
}

export class RemoteAgentFacade implements AgentFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async run(
    input: AgentRunInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentRunResult> {
    return await this.http.requestJson<AgentRunResult>(
      {
        method: 'POST',
        path: '/v1/agent',
        body: toAgentRunBody(input),
      },
      options,
    );
  }

  async startSession(
    input: AgentSessionStartInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentSessionStartResult> {
    return await this.http.requestJson<AgentSessionStartResult>(
      {
        method: 'POST',
        path: '/v1/agent/sessions',
        body: toAgentSessionStartBody(input),
      },
      options,
    );
  }

  async turnSession(
    input: AgentSessionTurnInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentSessionTurnResult> {
    return await this.http.requestJson<AgentSessionTurnResult>(
      {
        method: 'POST',
        path: `/v1/agent/sessions/${encodeURIComponent(input.sessionId)}/turns`,
        body: toAgentSessionTurnBody(input),
      },
      options,
    );
  }
}
