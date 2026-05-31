import { parseGlobalArgs } from './argv/parse-global-args.js';
import { hasCommandPathPrefix, parseCommandPath } from './argv/parse-command-path.js';
import { createDefaultRegistry, type CommandRegistry } from './command-registry.js';
import { renderCommandResult } from './render/render-command-result.js';
import { renderHelp } from './render/render-help.js';
import { resolveExitCode } from './render/exit-code.js';
import { realCliIo, type CliIo } from './io.js';
import { buildCommandContext } from '../../config/cli-container.js';
import { EXIT_SUCCESS } from '../../application/cli/command/exit-code.js';
import { CliError } from '../../application/cli/command/cli-error.js';
import type { CommandContext } from '../../application/cli/context/command-context.js';
import type { GlobalArgs } from '../../application/cli/context/global-args.js';

export interface RunCliDeps {
  readonly io: CliIo;
  readonly registry: CommandRegistry;
  /** Context factory — injectable so tests can supply fake facades. */
  readonly buildContext: (args: GlobalArgs) => CommandContext;
}

/**
 * The CLI shell's single execution path: parse globals -> resolve command ->
 * build context -> run -> render -> exit code. It NEVER calls `process.exit()`;
 * it returns the code and lets the thin entrypoint own the process. Returning
 * (not throwing) keeps it directly testable. Deps are merged per-field so
 * callers can override just one collaborator (e.g. inject fake facades).
 */
export async function runCli(
  argv: readonly string[],
  deps: Partial<RunCliDeps> = {},
): Promise<number> {
  const io = deps.io ?? realCliIo;
  const registry = deps.registry ?? createDefaultRegistry();
  const buildContext = deps.buildContext ?? ((args: GlobalArgs) => buildCommandContext(args));
  try {
    const { global, rest } = parseGlobalArgs(argv);
    const registeredPaths = registry.list().map((command) => command.path);
    const commandPath = parseCommandPath(rest, registeredPaths);

    if (global.help || (commandPath === null && rest.length === 0)) {
      renderHelp(registry, io);
      return EXIT_SUCCESS;
    }

    if (commandPath === null) {
      if (hasCommandPathPrefix(rest, registeredPaths)) {
        throw CliError.usage('Incomplete command. Run "wine --help" to see available commands.');
      }
      throw CliError.usage(`Unknown command "${rest.join(' ')}". Run "wine --help".`);
    }

    const command = registry.resolve(commandPath.path);
    if (command === undefined) {
      throw CliError.usage(`Unknown command "${commandPath.path.join(' ')}". Run "wine --help".`);
    }

    const ctx = buildContext(global);
    const args = command.parseArgs(commandPath.leafArgs);
    const result = await command.run(ctx, args);
    renderCommandResult(result, ctx.profile.outputFormat, io);
    return result.exitCode ?? EXIT_SUCCESS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeError(`error: ${message}\n`);
    return resolveExitCode(error);
  }
}
