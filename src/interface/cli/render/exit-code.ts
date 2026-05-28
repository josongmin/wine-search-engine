import { EXIT_EXECUTION } from '../../../application/cli/command/exit-code.js';
import { isCliError } from '../../../application/cli/command/cli-error.js';

/**
 * Shell-only mapping from a thrown error to a process exit code. Typed
 * {@link CliError}s carry their own semantic code; any unexpected error is
 * treated as an execution failure rather than being swallowed.
 */
export function resolveExitCode(error: unknown): number {
  if (isCliError(error)) {
    return error.exitCode;
  }
  return EXIT_EXECUTION;
}
