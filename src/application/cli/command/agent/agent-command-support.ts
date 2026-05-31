import type {
  AgentMessageInput,
  AgentRunInput,
  AgentSessionStartInput,
  AgentSessionTurnInput,
} from '../../dto/agent.dto.js';
import type { CommandContext } from '../../context/command-context.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parsePositiveInteger,
  resolveJsonOverlay,
} from '../command-arg-utils.js';

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw CliError.usage(`Invalid ${flag} "${value}" (expected a non-negative integer)`);
  }
  return parsed;
}

interface CommonAgentOptionArgs {
  readonly maxSteps?: number;
  readonly perStepTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly maxTotalTokens?: number;
}

export interface AgentRunArgs extends CommonAgentOptionArgs {
  readonly body?: string;
  readonly query?: string;
  readonly locale?: string;
  readonly currency?: string;
}

export interface AgentSessionStartArgs extends CommonAgentOptionArgs {
  readonly body?: string;
  readonly clientSessionId?: string;
  readonly locale?: string;
  readonly currency?: string;
}

export interface AgentSessionTurnArgs extends CommonAgentOptionArgs {
  readonly body?: string;
  readonly sessionId?: string;
  readonly clientTurnId?: string;
  readonly query?: string;
  // No --locale/--currency: per-turn context is fixed at session start.
  readonly expectedSessionVersion?: number;
}

function parseCommonAgentOptions(
  rawArgs: readonly string[],
  startIndex = 0,
): { readonly nextIndex: number; readonly parsed: CommonAgentOptionArgs } | null {
  const token = rawArgs[startIndex];
  switch (token) {
    case '--max-steps':
      return {
        nextIndex: startIndex + 1,
        parsed: { maxSteps: parsePositiveInteger(expectFlagValue(rawArgs, startIndex, token), token) },
      };
    case '--per-step-timeout-ms':
      return {
        nextIndex: startIndex + 1,
        parsed: { perStepTimeoutMs: parsePositiveInteger(expectFlagValue(rawArgs, startIndex, token), token) },
      };
    case '--agent-timeout-ms':
      return {
        nextIndex: startIndex + 1,
        parsed: { agentTimeoutMs: parsePositiveInteger(expectFlagValue(rawArgs, startIndex, token), token) },
      };
    case '--max-total-tokens':
      return {
        nextIndex: startIndex + 1,
        parsed: { maxTotalTokens: parsePositiveInteger(expectFlagValue(rawArgs, startIndex, token), token) },
      };
    default:
      return null;
  }
}

function buildAgentOptions(
  // run / session-start / session-turn share the same options shape.
  overlay: AgentRunInput['options'] | undefined,
  args: CommonAgentOptionArgs,
) {
  const hasOverride =
    args.maxSteps !== undefined
    || args.perStepTimeoutMs !== undefined
    || args.agentTimeoutMs !== undefined
    || args.maxTotalTokens !== undefined;
  if (!hasOverride) {
    return overlay;
  }
  return {
    ...(args.maxSteps !== undefined || overlay?.maxSteps !== undefined
      ? { maxSteps: args.maxSteps ?? overlay?.maxSteps }
      : {}),
    ...(args.perStepTimeoutMs !== undefined || overlay?.perStepTimeoutMs !== undefined
      ? { perStepTimeoutMs: args.perStepTimeoutMs ?? overlay?.perStepTimeoutMs }
      : {}),
    ...(args.agentTimeoutMs !== undefined || overlay?.agentTimeoutMs !== undefined
      ? { agentTimeoutMs: args.agentTimeoutMs ?? overlay?.agentTimeoutMs }
      : {}),
    ...(args.maxTotalTokens !== undefined || overlay?.maxTotalTokens !== undefined
      ? { maxTotalTokens: args.maxTotalTokens ?? overlay?.maxTotalTokens }
      : {}),
  };
}

function buildAgentContext(
  locale: string | undefined,
  currency: string | undefined,
  // run + session-start share the same context shape; session-turn has no
  // per-turn context (fixed at start), so it is not part of this union.
  overlay: AgentRunInput['context'] | undefined,
) {
  if (locale === undefined && currency === undefined) {
    return overlay;
  }
  const context = {
    locale: locale ?? overlay?.locale ?? '',
    currency: currency ?? overlay?.currency ?? '',
  };
  if (context.locale.length === 0 || context.currency.length === 0) {
    throw CliError.usage('context requires both locale and currency');
  }
  return context;
}

function singleUserMessage(query: string): readonly AgentMessageInput[] {
  return [{ role: 'user', content: query }];
}

function requireLatestUserMessage(messages: readonly AgentMessageInput[]): readonly AgentMessageInput[] {
  if (!messages.some((message) => message.role === 'user' && message.content.trim().length > 0)) {
    throw CliError.usage('agent request requires at least one non-empty user message');
  }
  return messages;
}

function resolveMessagesFromArgs(
  query: string | undefined,
  overlayMessages: readonly AgentMessageInput[] | undefined,
  commandLabel: string,
): readonly AgentMessageInput[] {
  if (query !== undefined && overlayMessages !== undefined) {
    throw CliError.usage(`${commandLabel} cannot combine --query with messages in --body`);
  }
  return query !== undefined
    ? singleUserMessage(query)
    : requireLatestUserMessage(overlayMessages ?? []);
}

export function parseAgentRunArgs(rawArgs: readonly string[]): AgentRunArgs {
  let body: string | undefined;
  let query: string | undefined;
  let locale: string | undefined;
  let currency: string | undefined;
  const common: CommonAgentOptionArgs = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    const parsedCommon = parseCommonAgentOptions(rawArgs, i);
    if (parsedCommon !== null) {
      Object.assign(common, parsedCommon.parsed);
      i = parsedCommon.nextIndex;
      continue;
    }
    switch (token) {
      case '--body':
        body = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--q':
      case '--query':
        query = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--locale':
        locale = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--currency':
        currency = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      default:
        throw CliError.usage(`Unknown agent run option "${token}"`);
    }
  }

  return {
    ...(body !== undefined ? { body } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...common,
  };
}

export async function resolveAgentRunInput(
  ctx: CommandContext,
  args: AgentRunArgs,
): Promise<AgentRunInput> {
  const overlay = await resolveJsonOverlay<AgentRunInput>(ctx, args.body);
  const messages = resolveMessagesFromArgs(args.query, overlay.messages, 'agent run');
  const context = buildAgentContext(args.locale, args.currency, overlay.context);
  const options = buildAgentOptions(overlay.options, args);
  return {
    messages,
    ...(context !== undefined ? { context } : {}),
    ...(options !== undefined ? { options } : {}),
  };
}

export function parseAgentSessionStartArgs(rawArgs: readonly string[]): AgentSessionStartArgs {
  let body: string | undefined;
  let clientSessionId: string | undefined;
  let locale: string | undefined;
  let currency: string | undefined;
  const common: CommonAgentOptionArgs = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    const parsedCommon = parseCommonAgentOptions(rawArgs, i);
    if (parsedCommon !== null) {
      Object.assign(common, parsedCommon.parsed);
      i = parsedCommon.nextIndex;
      continue;
    }
    switch (token) {
      case '--body':
        body = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--client-session-id':
        clientSessionId = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--locale':
        locale = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--currency':
        currency = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      default:
        throw CliError.usage(`Unknown agent session start option "${token}"`);
    }
  }

  return {
    ...(body !== undefined ? { body } : {}),
    ...(clientSessionId !== undefined ? { clientSessionId } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...common,
  };
}

export async function resolveAgentSessionStartInput(
  ctx: CommandContext,
  args: AgentSessionStartArgs,
): Promise<AgentSessionStartInput> {
  const overlay = await resolveJsonOverlay<AgentSessionStartInput>(ctx, args.body);
  const context = buildAgentContext(args.locale, args.currency, overlay.context);
  const options = buildAgentOptions(overlay.options, args);
  return {
    ...(args.clientSessionId !== undefined || overlay.clientSessionId !== undefined
      ? { clientSessionId: args.clientSessionId ?? overlay.clientSessionId }
      : {}),
    ...(context !== undefined ? { context } : {}),
    ...(options !== undefined ? { options } : {}),
  };
}

export function parseAgentSessionTurnArgs(rawArgs: readonly string[]): AgentSessionTurnArgs {
  let body: string | undefined;
  let sessionId: string | undefined;
  let clientTurnId: string | undefined;
  let query: string | undefined;
  let expectedSessionVersion: number | undefined;
  const common: CommonAgentOptionArgs = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    const parsedCommon = parseCommonAgentOptions(rawArgs, i);
    if (parsedCommon !== null) {
      Object.assign(common, parsedCommon.parsed);
      i = parsedCommon.nextIndex;
      continue;
    }
    switch (token) {
      case '--body':
        body = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--session-id':
        sessionId = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--client-turn-id':
        clientTurnId = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--q':
      case '--query':
        query = expectFlagValue(rawArgs, i, token);
        i += 1;
        break;
      case '--expected-session-version':
        expectedSessionVersion = parseNonNegativeInteger(expectFlagValue(rawArgs, i, token), token);
        i += 1;
        break;
      default:
        throw CliError.usage(`Unknown agent session turn option "${token}"`);
    }
  }

  return {
    ...(body !== undefined ? { body } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(clientTurnId !== undefined ? { clientTurnId } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(expectedSessionVersion !== undefined ? { expectedSessionVersion } : {}),
    ...common,
  };
}

export async function resolveAgentSessionTurnInput(
  ctx: CommandContext,
  args: AgentSessionTurnArgs,
): Promise<AgentSessionTurnInput> {
  const overlay = await resolveJsonOverlay<AgentSessionTurnInput>(ctx, args.body);
  const sessionId = args.sessionId ?? overlay.sessionId;
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw CliError.usage('agent session turn requires --session-id or sessionId in --body');
  }
  const clientTurnId = args.clientTurnId ?? overlay.clientTurnId ?? ctx.requestId;
  const messages = resolveMessagesFromArgs(args.query, overlay.messages, 'agent session turn');
  // Per-turn context is intentionally unsupported (fixed at session start).
  const options = buildAgentOptions(overlay.options, args);
  return {
    sessionId,
    clientTurnId,
    messages,
    ...(options !== undefined ? { options } : {}),
    ...(args.expectedSessionVersion !== undefined || overlay.expectedSessionVersion !== undefined
      ? { expectedSessionVersion: args.expectedSessionVersion ?? overlay.expectedSessionVersion }
      : {}),
  };
}
