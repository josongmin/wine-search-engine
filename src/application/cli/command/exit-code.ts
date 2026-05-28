/**
 * Stable CLI exit-code table (architecture decision §11). Commands never call
 * `process.exit()`; they throw {@link CliError} with a semantic failure kind,
 * and the shell maps it to one of these codes. Auth failures and business
 * failures are deliberately distinct so scripts can branch on them.
 */
export const EXIT_SUCCESS = 0;
/** Usage / config / auth-file invalid. */
export const EXIT_USAGE = 2;
/** Refresh / login failed. */
export const EXIT_AUTH = 3;
/** Remote/local command execution failed. */
export const EXIT_EXECUTION = 4;
/** Probe / doctor check failed. */
export const EXIT_PROBE = 5;

/** Semantic failure category a command can signal. */
export type CliFailureKind = 'usage' | 'auth' | 'execution' | 'probe';

export const EXIT_CODE_BY_KIND: Readonly<Record<CliFailureKind, number>> = {
  usage: EXIT_USAGE,
  auth: EXIT_AUTH,
  execution: EXIT_EXECUTION,
  probe: EXIT_PROBE,
};
