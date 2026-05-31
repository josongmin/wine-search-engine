import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';

export interface PingArgs {
  readonly note?: string;
}

/**
 * Hidden kernel self-test command. It carries no business logic — it only
 * proves the full execution path (argv parse -> registry resolve -> context
 * build -> run -> render -> exit) end to end. Excluded from the help tree so
 * the documented product surface (auth/search/entity/wine-search/api) stays
 * faithful to the RFC.
 */
export class PingCommand implements CliCommand<PingArgs> {
  readonly path = ['system', 'ping'] as const;
  readonly summary = 'Kernel self-test: echoes the resolved context.';
  readonly hidden = true;

  parseArgs(rawArgs: readonly string[]): PingArgs {
    const noteIndex = rawArgs.indexOf('--note');
    const note = noteIndex >= 0 ? rawArgs[noteIndex + 1] : undefined;
    return note != null ? { note } : {};
  }

  run(ctx: CommandContext, args: PingArgs): Promise<CommandResult> {
    return Promise.resolve({
      data: {
        ok: true,
        target: ctx.target,
        profile: ctx.profile.name,
        requestId: ctx.requestId,
        ...(args.note != null ? { note: args.note } : {}),
      },
    });
  }
}
