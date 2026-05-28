import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export class AuthRefreshCommand implements CliCommand {
  readonly group = 'auth';
  readonly name = 'refresh';
  readonly summary = 'Refresh the Codex access token using the stored refresh token.';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    // The facade throws CliError.auth (exit 3) when no refresh token exists.
    return { data: await ctx.facades.auth.refresh() };
  }
}
