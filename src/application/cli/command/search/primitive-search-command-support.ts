import type { PrimitiveSearchInput } from '../../dto/search.dto.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parsePositiveInteger,
  resolveJsonOverlay,
} from '../command-arg-utils.js';
import type { CommandContext } from '../../context/command-context.js';

export interface PrimitiveSearchArgs {
  readonly body?: string;
  readonly query?: string;
  readonly locale?: string;
  readonly currency?: string;
  readonly maxLatencyMs?: number;
  readonly maxCandidates?: number;
  readonly rerankLimit?: number;
  readonly limit?: number;
}

export function parsePrimitiveSearchArgs(rawArgs: readonly string[], commandLabel: string): PrimitiveSearchArgs {
  let body: string | undefined;
  let query: string | undefined;
  let locale: string | undefined;
  let currency: string | undefined;
  let maxLatencyMs: number | undefined;
  let maxCandidates: number | undefined;
  let rerankLimit: number | undefined;
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
      case '--limit':
        limit = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
        i += 1;
        break;
      default:
        throw CliError.usage(`Unknown ${commandLabel} option "${token}"`);
    }
  }

  return {
    ...(body !== undefined ? { body } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(maxLatencyMs !== undefined ? { maxLatencyMs } : {}),
    ...(maxCandidates !== undefined ? { maxCandidates } : {}),
    ...(rerankLimit !== undefined ? { rerankLimit } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export async function resolvePrimitiveSearchInput(
  ctx: CommandContext,
  args: PrimitiveSearchArgs,
  commandLabel: string,
): Promise<PrimitiveSearchInput> {
  const overlay = await resolveJsonOverlay<PrimitiveSearchInput>(ctx, args.body);
  const query = args.query ?? overlay.query;
  if (query === undefined || query.trim().length === 0) {
    throw CliError.usage(`${commandLabel} requires --q/--query or query in --body`);
  }

  const hasContextOverride = args.locale !== undefined || args.currency !== undefined;
  const context = hasContextOverride
    ? {
        locale: args.locale ?? overlay.context?.locale ?? '',
        currency: args.currency ?? overlay.context?.currency ?? '',
      }
    : overlay.context;
  if (context !== undefined && (context.locale.length === 0 || context.currency.length === 0)) {
    throw CliError.usage('context requires both locale and currency');
  }

  const hasBudgetOverride =
    args.maxLatencyMs !== undefined || args.maxCandidates !== undefined || args.rerankLimit !== undefined;
  const queryBudget = hasBudgetOverride
    ? {
        maxLatencyMs: args.maxLatencyMs ?? overlay.queryBudget?.maxLatencyMs ?? 0,
        maxCandidates: args.maxCandidates ?? overlay.queryBudget?.maxCandidates ?? 0,
        rerankLimit: args.rerankLimit ?? overlay.queryBudget?.rerankLimit ?? 0,
      }
    : overlay.queryBudget;
  if (
    queryBudget !== undefined
    && (queryBudget.maxLatencyMs <= 0 || queryBudget.maxCandidates <= 0 || queryBudget.rerankLimit <= 0)
  ) {
    throw CliError.usage('query budget requires max_latency_ms, max_candidates, rerank_limit');
  }

  return {
    query,
    ...(context !== undefined ? { context } : {}),
    ...(queryBudget !== undefined ? { queryBudget } : {}),
    ...(args.limit !== undefined || overlay.limit !== undefined
      ? { limit: args.limit ?? overlay.limit }
      : {}),
    ...(overlay.filters !== undefined ? { filters: overlay.filters } : {}),
    ...(overlay.preferences !== undefined ? { preferences: overlay.preferences } : {}),
  };
}
