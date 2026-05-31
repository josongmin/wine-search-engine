/**
 * AgentUseCasePort — the SINGLE application seam for the agent surface.
 *
 * Every transport (HTTP routes, local CLI facade) depends on THIS port and
 * nothing deeper: it never reaches into the orchestrator or session service
 * directly. The use case owns the run/turn user-message guard and the
 * session-availability guard, and delegates:
 *   - `run`                                   → orchestrator (caller-managed history)
 *   - `createSession`/`getSession`/`runTurn`  → session service (server-managed)
 *
 * Inputs are camelCase application commands; transports map their wire shapes
 * (snake_case HTTP / camelCase CLI DTO) to these ONCE at the edge. The port
 * returns domain results/outcomes — transports own presentation (wire shaping)
 * and status mapping of the outcome union.
 */

import type { AgentMessage, AgentRequestContext, AgentRequestOptions } from '../wine-search-schemas.js';
import type { WineSearchResult } from '../wine-search-result-schemas.js';
import type {
  AgentSessionRecord,
  CreateAgentSessionResult,
} from './agent-session-store.port.js';
import type {
  CreateAgentSessionCommand,
  RunAgentTurnCommand,
  RunAgentTurnOutcome,
} from '../agent-session-service.js';

/** Single-shot run command — caller-managed history (the full conversation is
 *  supplied in `messages`). No session id; no server persistence. */
export interface AgentRunCommand {
  readonly messages: readonly AgentMessage[];
  readonly requestId: string;
  readonly context?: AgentRequestContext | undefined;
  readonly options?: AgentRequestOptions | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface AgentUseCasePort {
  /** Single-shot run. Throws `DomainError('INVALID_REQUEST')` (→ 400) when
   *  `messages` carries no user-role message (the planner anchor). */
  run(cmd: AgentRunCommand): Promise<WineSearchResult>;
  /** Session ops throw `DomainError('SERVICE_UNAVAILABLE')` (→ 503) when no
   *  persistent session store is wired. Outcome-level failures
   *  (`version_conflict` / `session_not_found`) are RETURNED in the
   *  discriminated union, NOT thrown — the transport maps those to 409 / 404. */
  createSession(cmd: CreateAgentSessionCommand): Promise<CreateAgentSessionResult>;
  getSession(sessionId: string): Promise<AgentSessionRecord | null>;
  runTurn(cmd: RunAgentTurnCommand): Promise<RunAgentTurnOutcome>;
}
