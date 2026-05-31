import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export class AuthPathCommand implements CliCommand {
  readonly path = ['auth', 'path'] as const;
  readonly summary = 'Print the Codex auth file path and whether it exists.';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    return { data: await ctx.facades.auth.path() };
  }
}
