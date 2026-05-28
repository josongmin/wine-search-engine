import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export class AuthLoginCommand implements CliCommand {
  readonly group = 'auth';
  readonly name = 'login';
  readonly summary = 'Delegate login to Codex (this CLI does not own OAuth).';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    const result = await ctx.facades.auth.login();
    return { data: result, warnings: [result.message] };
  }
}
