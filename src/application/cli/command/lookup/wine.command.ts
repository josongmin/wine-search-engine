import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parsePrimitiveSearchArgs,
  resolvePrimitiveSearchInput,
  type PrimitiveSearchArgs,
} from '../search/primitive-search-command-support.js';

export class LookupWineCommand implements CliCommand<PrimitiveSearchArgs> {
  readonly path = ['lookup', 'wine'] as const;
  readonly summary = 'Resolve a canonical wine entity via POST /v2/entity-lookup (V2-native 4-state result).';

  parseArgs(rawArgs: readonly string[]): PrimitiveSearchArgs {
    return parsePrimitiveSearchArgs(rawArgs, 'lookup wine');
  }

  async run(ctx: CommandContext, args: PrimitiveSearchArgs): Promise<CommandResult> {
    const input = await resolvePrimitiveSearchInput(ctx, args, 'lookup wine');
    return {
      data: await ctx.facades.lookup.lookupWine(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
