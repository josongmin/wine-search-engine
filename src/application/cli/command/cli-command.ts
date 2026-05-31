import type { CommandContext } from '../context/command-context.js';
import type { CommandResult } from '../context/command-result.js';

/**
 * Contract every CLI leaf command implements. The kernel resolves a command
 * by `${group} ${name}`, lets it parse its own local args, then runs it on a
 * fully-assembled {@link CommandContext}.
 *
 * A command MUST NOT write to stdout, read `process.env`, or call
 * `process.exit()` — those belong to the shell. It returns a typed
 * {@link CommandResult} and throws `CliError` for failures.
 */
export interface CliCommand<TArgs = unknown> {
  readonly path: readonly [string, string, ...string[]];
  /** One-line summary used by `--help`. */
  readonly summary: string;
  /**
   * When true, the command is reachable but omitted from the help tree.
   * Used for kernel self-test/diagnostic commands.
   */
  readonly hidden?: boolean;
  /** Parses command-local args (everything after the resolved command path). */
  parseArgs(rawArgs: readonly string[]): TArgs;
  run(ctx: CommandContext, args: TArgs): Promise<CommandResult>;
}
