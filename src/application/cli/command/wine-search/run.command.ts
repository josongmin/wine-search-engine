import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import type { WineSearchRunInput } from '../../dto/wine-search.dto.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parsePositiveInteger,
  resolveJsonOverlay,
} from '../command-arg-utils.js';

interface WineSearchArgs {
  readonly body?: string;
  readonly query?: string;
  readonly maxSteps?: number;
  readonly perStepTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly maxTotalTokens?: number;
}

function buildInput(args: WineSearchArgs, overlay: Partial<WineSearchRunInput>): WineSearchRunInput {
  const query = args.query ?? overlay.query;
  if (query === undefined || query.trim().length === 0) {
    throw CliError.usage('wine-search run requires --q/--query or query in --body');
  }
  return {
    query,
    ...(args.maxSteps !== undefined || overlay.maxSteps !== undefined
      ? { maxSteps: args.maxSteps ?? overlay.maxSteps }
      : {}),
    ...(args.perStepTimeoutMs !== undefined || overlay.perStepTimeoutMs !== undefined
      ? { perStepTimeoutMs: args.perStepTimeoutMs ?? overlay.perStepTimeoutMs }
      : {}),
    ...(args.agentTimeoutMs !== undefined || overlay.agentTimeoutMs !== undefined
      ? { agentTimeoutMs: args.agentTimeoutMs ?? overlay.agentTimeoutMs }
      : {}),
    ...(args.maxTotalTokens !== undefined || overlay.maxTotalTokens !== undefined
      ? { maxTotalTokens: args.maxTotalTokens ?? overlay.maxTotalTokens }
      : {}),
  };
}

export class WineSearchRunCommand implements CliCommand<WineSearchArgs> {
  readonly group = 'wine-search';
  readonly name = 'run';
  readonly summary = 'Execute plan-then-execute wine search locally or via remote /v1/agent.';

  parseArgs(rawArgs: readonly string[]): WineSearchArgs {
    let body: string | undefined;
    let query: string | undefined;
    let maxSteps: number | undefined;
    let perStepTimeoutMs: number | undefined;
    let agentTimeoutMs: number | undefined;
    let maxTotalTokens: number | undefined;

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
        case '--max-steps':
          maxSteps = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--per-step-timeout-ms':
          perStepTimeoutMs = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--agent-timeout-ms':
          agentTimeoutMs = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        case '--max-total-tokens':
          maxTotalTokens = parsePositiveInteger(expectFlagValue(rawArgs, i, token), token);
          i += 1;
          break;
        default:
          throw CliError.usage(`Unknown wine-search run option "${token}"`);
      }
    }

    return {
      ...(body !== undefined ? { body } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(perStepTimeoutMs !== undefined ? { perStepTimeoutMs } : {}),
      ...(agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
      ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    };
  }

  async run(ctx: CommandContext, args: WineSearchArgs): Promise<CommandResult> {
    const overlay = await resolveJsonOverlay<WineSearchRunInput>(ctx, args.body);
    const input = buildInput(args, overlay);
    return {
      data: await ctx.facades.wineSearch.run(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
