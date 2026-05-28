import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export class AuthWhoamiCommand implements CliCommand {
  readonly group = 'auth';
  readonly name = 'whoami';
  readonly summary = 'Show the authenticated Codex account id and email, if available.';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    return { data: await ctx.facades.auth.whoami() };
  }
}
