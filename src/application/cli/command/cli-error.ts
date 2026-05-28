import { EXIT_CODE_BY_KIND, type CliFailureKind } from './exit-code.js';

/**
 * The single error type CLI commands and the shell throw to signal a typed
 * failure. The `kind` selects the exit code (see {@link EXIT_CODE_BY_KIND}),
 * keeping exit-code policy out of individual commands.
 */
export class CliError extends Error {
  readonly kind: CliFailureKind;
  readonly exitCode: number;

  constructor(kind: CliFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
    this.kind = kind;
    this.exitCode = EXIT_CODE_BY_KIND[kind];
  }

  static usage(message: string, options?: ErrorOptions): CliError {
    return new CliError('usage', message, options);
  }

  static auth(message: string, options?: ErrorOptions): CliError {
    return new CliError('auth', message, options);
  }

  static execution(message: string, options?: ErrorOptions): CliError {
    return new CliError('execution', message, options);
  }

  static probe(message: string, options?: ErrorOptions): CliError {
    return new CliError('probe', message, options);
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
