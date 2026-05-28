import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export class AuthStatusCommand implements CliCommand {
  readonly group = 'auth';
  readonly name = 'status';
  readonly summary = 'Show Codex auth status (authenticated, tokens, account).';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    return { data: await ctx.facades.auth.status() };
  }
}
