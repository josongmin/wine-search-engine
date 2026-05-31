import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import { EXIT_PROBE } from '../exit-code.js';

export class AuthDoctorCommand implements CliCommand {
  readonly path = ['auth', 'doctor'] as const;
  readonly summary = 'Diagnose Codex auth: file, mode, tokens, model-catalog probe.';

  parseArgs(): Record<string, never> {
    return {};
  }

  async run(ctx: CommandContext): Promise<CommandResult> {
    const result = await ctx.facades.auth.doctor({
      target: ctx.profile.target,
      ...(ctx.profile.baseUrl !== undefined ? { baseUrl: ctx.profile.baseUrl } : {}),
      authMode: ctx.profile.authMode,
    });
    return {
      data: result,
      ...(result.healthy ? {} : { exitCode: EXIT_PROBE }),
    };
  }
}
