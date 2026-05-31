import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parsePrimitiveSearchArgs,
  resolvePrimitiveSearchInput,
  type PrimitiveSearchArgs,
} from './primitive-search-command-support.js';

export class SearchHybridCommand implements CliCommand<PrimitiveSearchArgs> {
  readonly path = ['search', 'hybrid'] as const;
  readonly summary = 'Execute path-authoritative hybrid retrieval via /v1/search/hybrid.';

  parseArgs(rawArgs: readonly string[]): PrimitiveSearchArgs {
    return parsePrimitiveSearchArgs(rawArgs, 'search hybrid');
  }

  async run(ctx: CommandContext, args: PrimitiveSearchArgs): Promise<CommandResult> {
    const input = await resolvePrimitiveSearchInput(ctx, args, 'search hybrid');
    return {
      data: await ctx.facades.search.hybrid(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
