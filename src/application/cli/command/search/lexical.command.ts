import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parsePrimitiveSearchArgs,
  resolvePrimitiveSearchInput,
  type PrimitiveSearchArgs,
} from './primitive-search-command-support.js';

export class SearchLexicalCommand implements CliCommand<PrimitiveSearchArgs> {
  readonly path = ['search', 'lexical'] as const;
  readonly summary = 'Execute sparse lexical retrieval via /v1/search/lexical.';

  parseArgs(rawArgs: readonly string[]): PrimitiveSearchArgs {
    return parsePrimitiveSearchArgs(rawArgs, 'search lexical');
  }

  async run(ctx: CommandContext, args: PrimitiveSearchArgs): Promise<CommandResult> {
    const input = await resolvePrimitiveSearchInput(ctx, args, 'search lexical');
    return {
      data: await ctx.facades.search.lexical(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
