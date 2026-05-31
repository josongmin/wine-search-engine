import type { CliFacadeRequestOptions } from './facade-request-options.port.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentSessionStartInput,
  AgentSessionStartResult,
  AgentSessionTurnInput,
  AgentSessionTurnResult,
} from '../dto/agent.dto.js';

export interface AgentFacadePort {
  run(input: AgentRunInput, options: CliFacadeRequestOptions): Promise<AgentRunResult>;
  startSession(
    input: AgentSessionStartInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentSessionStartResult>;
  turnSession(
    input: AgentSessionTurnInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentSessionTurnResult>;
}
