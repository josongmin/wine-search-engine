import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import type { SearchRunInput } from '../../dto/search.dto.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parsePositiveInteger,
  resolveJsonOverlay,
} from '../command-arg-utils.js';

interface SearchRunArgs {
  readonly body?: string;
  readonly query?: string;
  readonly locale?: string;
  readonly currency?: string;
  readonly sessionId?: string;
  readonly previousEntities: readonly string[];
  readonly maxLatencyMs?: number;
  readonly maxCandidates?: number;
  readonly rerankLimit?: number;
  readonly mode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
  readonly explain?: boolean | undefined;
  readonly clarification?: boolean | undefined;
  readonly retrievalMode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
  readonly limit?: number;
}

function parseMode(
  value: string,
  flag: '--mode' | '--retrieval-mode',
): 'auto' | 'entity' | 'hybrid' | 'mixed' {
  if (value === 'auto' || value === 'entity' || value === 'hybrid' || value === 'mixed') {
    return value;
  }
  throw CliError.usage(`Invalid ${flag} "${value}" (expected auto|entity|hybrid|mixed)`);
}

function buildInput(args: SearchRunArgs, overlay: Partial<SearchRunInput>): SearchRunInput {
  const query = args.query ?? overlay.query;
  if (query === undefined || query.trim().length === 0) {
    throw CliError.usage('search run requires --q/--query or query in --body');
  }

  const overlayContext = overlay.context;
  const context =
    args.locale !== undefined || args.currency !== undefined
      ? {
          locale: args.locale ?? overlayContext?.locale ?? '',
          currency: args.currency ?? overlayContext?.currency ?? '',
        }
      : overlayContext;
  if (context !== undefined && (context.locale.length === 0 || context.currency.length === 0)) {
    throw CliError.usage('context requires both locale and currency');
  }

  const overlaySession = overlay.sessionContext;
  const hasSessionOverride = args.sessionId !== undefined || args.previousEntities.length > 0;
  const sessionContext = hasSessionOverride
    ? {
        sessionId: args.sessionId ?? overlaySession?.sessionId ?? '',
        previousEntities:
          args.previousEntities.length > 0
            ? [...args.previousEntities]
            : [...(overlaySession?.previousEntities ?? [])],
      }
    : overlaySession;
  if (sessionContext !== undefined && sessionContext.sessionId.length === 0) {
    throw CliError.usage('session context requires session_id/--session-id');
  }

  const overlayBudget = overlay.queryBudget;
  const hasBudgetOverride =
    args.maxLatencyMs !== undefined || args.maxCandidates !== undefined || args.rerankLimit !== undefined;
  const queryBudget = hasBudgetOverride
    ? {
        maxLatencyMs: args.maxLatencyMs ?? overlayBudget?.maxLatencyMs ?? 0,
        maxCandidates: args.maxCandidates ?? overlayBudget?.maxCandidates ?? 0,
        rerankLimit: args.rerankLimit ?? overlayBudget?.rerankLimit ?? 0,
      }
    : overlayBudget;
  if (
    queryBudget !== undefined
    && (queryBudget.maxLatencyMs <= 0 || queryBudget.maxCandidates <= 0 || queryBudget.rerankLimit <= 0)
  ) {
    throw CliError.usage('query budget requires max_latency_ms, max_candidates, rerank_limit');
  }

  const hasOptionOverride =
    args.mode !== undefined || args.explain !== undefined || args.clarification !== undefined;
  const options = hasOptionOverride
    ? {
        mode: args.mode ?? overlay.options?.mode ?? 'auto',
        explain: args.explain ?? overlay.options?.explain ?? false,
        clarification: args.clarification ?? overlay.options?.clarification ?? false,
      }
    : overlay.options;

  return {
    query,
    ...(context !== undefined ? { context } : {}),
    ...(sessionContext !== undefined ? { sessionContext } : {}),
    ...(queryBudget !== undefined ? { queryBudget } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(args.retrievalMode !== undefined || overlay.retrievalMode !== undefined
      ? { retrievalMode: args.retrievalMode ?? overlay.retrievalMode }
      : {}),
    ...(args.limit !== undefined || overlay.limit !== undefined
      ? { limit: args.limit ?? overlay.limit }
      : {}),
    ...(overlay.filters !== undefined ? { filters: overlay.filters } : {}),
    ...(overlay.preferences !== undefined ? { preferences: overlay.preferences } : {}),
    ...(overlay.representativeConcept !== undefined
      ? { representativeConcept: overlay.representativeConcept }
      : {}),
  };
}

export class SearchRunCommand implements CliCommand<SearchRunArgs> {
  readonly group = 'search';
  readonly name = 'run';
  readonly summary = 'Execute typed search against local ports or remote /v1/search.';

  parseArgs(rawArgs: readonly string[]): SearchRunArgs {
    let body: string | undefined;
    let query: string | undefined;
    let locale: string | undefined;
    let currency: string | undefined;
    let sessionId: string | undefined;
    const previousEntities: string[] = [];
    let maxLatencyMs: number | undefined;
    let maxCandidates: number | undefined;
    let rerankLimit: number | undefined;
    let mode: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
    let explain: boolean | undefined;
    let clarification: boolean | undefined;
    let retrievalMode: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
    let limit: number | undefined;

    for (let i = 0; i < rawArgs.length; i += 1) {
      const token = rawArgs[i];
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
        case '--session-id':
          sessionId = expectFlagValue(rawArgs, i, token);
          i += 1;
          break;
        case '--previous-entity':
          previousEntities.push(expectFlagValue(rawArgs, i, token));
          i += 1;
          break;
        case '--max-latency-ms':
          maxLatencyMs = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--max-candidates':
          maxCandidates = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--rerank-limit':
          rerankLimit = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--mode':
          mode = parseMode(expectFlagValue(rawArgs, i, token), '--mode');
          i += 1;
          break;
        case '--retrieval-mode':
          retrievalMode = parseMode(expectFlagValue(rawArgs, i, token), '--retrieval-mode');
          i += 1;
          break;
        case '--explain':
          explain = true;
          break;
        case '--clarification':
          clarification = true;
          break;
        case '--limit':
          limit = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        default:
          throw CliError.usage(`Unknown search run option "${token}"`);
      }
    }

    return {
      ...(body !== undefined ? { body } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      previousEntities,
      ...(maxLatencyMs !== undefined ? { maxLatencyMs } : {}),
      ...(maxCandidates !== undefined ? { maxCandidates } : {}),
      ...(rerankLimit !== undefined ? { rerankLimit } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(explain !== undefined ? { explain } : {}),
      ...(clarification !== undefined ? { clarification } : {}),
      ...(retrievalMode !== undefined ? { retrievalMode } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  async run(ctx: CommandContext, args: SearchRunArgs): Promise<CommandResult> {
    const overlay = await resolveJsonOverlay<SearchRunInput>(ctx, args.body);
    const input = buildInput(args, overlay);
    return {
      data: await ctx.facades.search.run(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
