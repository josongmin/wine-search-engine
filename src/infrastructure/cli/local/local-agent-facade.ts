import type { AgentFacadePort } from '../../../application/cli/port/agent-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentSessionStartInput,
  AgentSessionStartResult,
  AgentSessionTurnInput,
  AgentSessionTurnResult,
} from '../../../application/cli/dto/agent.dto.js';
import { CliError } from '../../../application/cli/command/cli-error.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import {
  mapWineSearchResultToResponse,
  buildSessionDescriptor,
  buildTurnResponse,
} from '../../../application/wine-search/presentation/agent-presentation.js';
import type { AgentUseCasePort } from '../../../application/wine-search/port/agent-usecase.port.js';
import type { AgentSessionCreateResponseBody } from '../../../interface/http/schemas/agent.schema.js';
import type { Container } from '../../../config/container.js';
import { LocalContainerRuntime } from './local-container-runtime.js';

/** Translate the use case's session-unavailable DomainError into a CLI-shaped
 *  error with the local-specific remediation hint. Other errors pass through
 *  (the CLI runner's error-formatter handles DomainError/CliError uniformly). */
function translateSessionError(err: unknown): never {
  if (err instanceof DomainError && err.code === 'SERVICE_UNAVAILABLE') {
    throw CliError.execution(
      'Local agent sessions are unavailable: no persistent session store is configured (set AGENT_SESSION_DB_PATH).',
    );
  }
  throw err;
}

/**
 * LocalAgentFacade — THIN CLI transport. It resolves the single
 * {@link AgentUseCasePort} from the in-process container and delegates; it owns
 * NO business logic (validation/history/options live behind the use case, same
 * as the HTTP route). Its only transport jobs are: resolve the use case,
 * shape the wire response (presentation), and map session outcomes/errors to
 * CLI errors.
 */
export class LocalAgentFacade implements AgentFacadePort {
  constructor(
    private readonly runtime: Pick<LocalContainerRuntime, 'withContainer'> = new LocalContainerRuntime(),
  ) {}

  private useCase(container: Container): AgentUseCasePort {
    const useCase = container.wineSearch?.agentUseCase;
    if (useCase === undefined) {
      throw CliError.execution(
        'Local agent is unavailable: WINE_SEARCH_ENABLED/Anthropic wiring is not active.',
      );
    }
    return useCase;
  }

  async run(input: AgentRunInput, options: CliFacadeRequestOptions): Promise<AgentRunResult> {
    return await this.runtime.withContainer(async (container) => {
      const result = await this.useCase(container).run({
        messages: input.messages,
        requestId: options.requestId,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
        ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      });
      return mapWineSearchResultToResponse(result, options.requestId);
    });
  }

  async startSession(
    input: AgentSessionStartInput,
    _options: CliFacadeRequestOptions,
  ): Promise<AgentSessionStartResult> {
    return await this.runtime.withContainer(async (container) => {
      const useCase = this.useCase(container);
      try {
        const created = await useCase.createSession({
          ...(input.clientSessionId !== undefined ? { clientSessionId: input.clientSessionId } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
        });
        const body: AgentSessionCreateResponseBody = {
          session: buildSessionDescriptor(created.session),
          replayed: created.kind === 'idempotent_replay',
        };
        return body;
      } catch (err) {
        translateSessionError(err);
      }
    });
  }

  async turnSession(
    input: AgentSessionTurnInput,
    options: CliFacadeRequestOptions,
  ): Promise<AgentSessionTurnResult> {
    return await this.runtime.withContainer(async (container) => {
      const useCase = this.useCase(container);
      let outcome;
      try {
        outcome = await useCase.runTurn({
          sessionId: input.sessionId,
          clientTurnId: input.clientTurnId,
          messages: input.messages,
          requestId: options.requestId,
          ...(input.options !== undefined ? { options: input.options } : {}),
          ...(input.expectedSessionVersion !== undefined
            ? { expectedSessionVersion: input.expectedSessionVersion }
            : {}),
          ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        });
      } catch (err) {
        translateSessionError(err);
      }

      switch (outcome.kind) {
        case 'appended':
        case 'idempotent_replay': {
          const response = mapWineSearchResultToResponse(outcome.result, options.requestId);
          return buildTurnResponse(response, outcome.session, outcome.turn, outcome.replayed);
        }
        case 'version_conflict':
          throw CliError.execution(
            `agent session version conflict; current version is ${String(outcome.currentVersion)}`,
          );
        case 'session_not_found':
          throw CliError.usage(`agent session "${input.sessionId}" was not found`);
      }
    });
  }
}
