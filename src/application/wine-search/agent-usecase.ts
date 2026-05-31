/**
 * AgentUseCase — concrete {@link AgentUseCasePort}. The single seam both the
 * HTTP routes and the local CLI facade call. Owns the run/turn user-message
 * guard + the session-availability guard, and composes the orchestrator (run)
 * with the session service (sessions). Transport concerns (abort wiring, wire
 * shaping, outcome→status mapping) stay in the transports; business logic
 * (history custody, planning) stays in the orchestrator/service.
 */

import { DomainError } from '@domain/shared/error/domain-error.js';
import type { WineSearchOrchestratorContract } from './wine-search-orchestrator.js';
import type { WineSearchResult } from './wine-search-result-schemas.js';
import { hasUserMessage } from './wine-search-schemas.js';
import type {
  AgentSessionService,
  CreateAgentSessionCommand,
  RunAgentTurnCommand,
  RunAgentTurnOutcome,
} from './agent-session-service.js';
import type {
  AgentSessionRecord,
  CreateAgentSessionResult,
} from './port/agent-session-store.port.js';
import type { AgentRunCommand, AgentUseCasePort } from './port/agent-usecase.port.js';

export interface AgentUseCaseDeps {
  readonly orchestrator: WineSearchOrchestratorContract;
  /** Absent when no persistent session store is wired — `run` still works
   *  (orchestrator only); session methods then fail closed with 503. */
  readonly sessionService?: AgentSessionService | undefined;
}

const SESSIONS_UNAVAILABLE_MESSAGE = 'Agent session surface is unavailable.';

export class AgentUseCase implements AgentUseCasePort {
  private readonly orchestrator: WineSearchOrchestratorContract;
  private readonly sessionService: AgentSessionService | undefined;

  constructor(deps: AgentUseCaseDeps) {
    this.orchestrator = deps.orchestrator;
    this.sessionService = deps.sessionService;
  }

  /** Fail closed (→ 503) when no persistent store backs the session surface.
   *  Centralized here so neither transport repeats the availability guard. */
  private requireSessions(): AgentSessionService {
    if (this.sessionService === undefined) {
      throw new DomainError('SERVICE_UNAVAILABLE', SESSIONS_UNAVAILABLE_MESSAGE);
    }
    return this.sessionService;
  }

  async run(cmd: AgentRunCommand): Promise<WineSearchResult> {
    // Fail fast on a conversation with no planner anchor — transport-neutral
    // DomainError (HTTP → 400, CLI → exit 1). Without this the orchestrator's
    // admit gate would return a 200 coverage-gap shell instead.
    if (!hasUserMessage(cmd.messages)) {
      throw new DomainError(
        'INVALID_REQUEST',
        'agent run requires at least one message with role="user"',
      );
    }
    return this.orchestrator.execute({
      messages: cmd.messages,
      requestId: cmd.requestId,
      ...(cmd.context !== undefined ? { context: cmd.context } : {}),
      ...(cmd.options !== undefined ? { options: cmd.options } : {}),
      ...(cmd.abortSignal !== undefined ? { abortSignal: cmd.abortSignal } : {}),
    });
  }

  async createSession(cmd: CreateAgentSessionCommand): Promise<CreateAgentSessionResult> {
    return this.requireSessions().createSession(cmd);
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | null> {
    return this.requireSessions().getSession(sessionId);
  }

  async runTurn(cmd: RunAgentTurnCommand): Promise<RunAgentTurnOutcome> {
    const sessions = this.requireSessions();
    // The session turn requires a user message too — same guard, same error.
    if (!hasUserMessage(cmd.messages)) {
      throw new DomainError(
        'INVALID_REQUEST',
        'agent session turn requires at least one message with role="user"',
      );
    }
    return sessions.runTurn(cmd);
  }
}
