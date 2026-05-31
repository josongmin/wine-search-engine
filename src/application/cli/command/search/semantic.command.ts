import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parsePrimitiveSearchArgs,
  resolvePrimitiveSearchInput,
  type PrimitiveSearchArgs,
} from './primitive-search-command-support.js';

export class SearchSemanticCommand implements CliCommand<PrimitiveSearchArgs> {
  readonly path = ['search', 'semantic'] as const;
  readonly summary = 'Execute dense-only retrieval via /v1/search/semantic.';

  parseArgs(rawArgs: readonly string[]): PrimitiveSearchArgs {
    return parsePrimitiveSearchArgs(rawArgs, 'search semantic');
  }

  async run(ctx: CommandContext, args: PrimitiveSearchArgs): Promise<CommandResult> {
    const input = await resolvePrimitiveSearchInput(ctx, args, 'search semantic');
    return {
      data: await ctx.facades.search.semantic(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
