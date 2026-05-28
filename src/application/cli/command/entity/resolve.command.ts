import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import type { EntityResolveInput } from '../../dto/entity.dto.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parsePositiveInteger,
  resolveJsonOverlay,
} from '../command-arg-utils.js';

interface EntityResolveArgs {
  readonly body?: string;
  readonly query?: string;
  readonly locale?: string;
  readonly currency?: string;
  readonly sessionId?: string;
  readonly previousEntities: readonly string[];
  readonly maxLatencyMs?: number;
  readonly maxCandidates?: number;
  readonly rerankLimit?: number;
}

function buildInput(args: EntityResolveArgs, overlay: Partial<EntityResolveInput>): EntityResolveInput {
  const query = args.query ?? overlay.query;
  if (query === undefined || query.trim().length === 0) {
    throw CliError.usage('entity resolve requires --q/--query or query in --body');
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

  const hasBudgetOverride =
    args.maxLatencyMs !== undefined || args.maxCandidates !== undefined || args.rerankLimit !== undefined;
  const overlayBudget = overlay.queryBudget;
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

  return {
    query,
    ...(context !== undefined ? { context } : {}),
    ...(sessionContext !== undefined ? { sessionContext } : {}),
    ...(queryBudget !== undefined ? { queryBudget } : {}),
  };
}

export class EntityResolveCommand implements CliCommand<EntityResolveArgs> {
  readonly group = 'entity';
  readonly name = 'resolve';
  readonly summary = 'Resolve an entity through local ports or remote /v1/entity/resolve.';

  parseArgs(rawArgs: readonly string[]): EntityResolveArgs {
    let body: string | undefined;
    let query: string | undefined;
    let locale: string | undefined;
    let currency: string | undefined;
    let sessionId: string | undefined;
    const previousEntities: string[] = [];
    let maxLatencyMs: number | undefined;
    let maxCandidates: number | undefined;
    let rerankLimit: number | undefined;

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
        default:
          throw CliError.usage(`Unknown entity resolve option "${token}"`);
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
    };
  }

  async run(ctx: CommandContext, args: EntityResolveArgs): Promise<CommandResult> {
    const overlay = await resolveJsonOverlay<EntityResolveInput>(ctx, args.body);
    const input = buildInput(args, overlay);
    return {
      data: await ctx.facades.entity.resolve(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
