import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import { CliError } from '../cli-error.js';

export class ApiOpenApiCommand implements CliCommand<Record<string, never>> {
  readonly group = 'api';
  readonly name = 'openapi';
  readonly summary = 'Fetch or build the OpenAPI bridge document (/openapi.json).';

  parseArgs(rawArgs: readonly string[]): Record<string, never> {
    if (rawArgs.length > 0) {
      throw CliError.usage(`Unknown api openapi option "${rawArgs[0]}"`);
    }
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    return {
      data: await ctx.facades.rawApi.openApi({
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
