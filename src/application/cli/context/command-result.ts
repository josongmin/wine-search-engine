/**
 * Normalized result every CLI leaf command returns. The command produces
 * typed `data`; the renderer (interface layer) decides the output format.
 * Commands MUST NOT write to stdout directly.
 *
 * `exitCode` is an optional command-level override. When omitted the shell
 * maps success to `EXIT_SUCCESS`; failures are signalled by throwing a
 * `CliError`, not by returning a non-zero code here.
 */
export interface CommandResult {
  readonly data: unknown;
  readonly warnings?: readonly string[];
  readonly metrics?: Record<string, unknown>;
  readonly renderAs?: 'default' | 'raw-api';
  readonly exitCode?: number;
}
