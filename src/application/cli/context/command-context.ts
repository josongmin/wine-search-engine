import type { CliFacadeRegistry } from '../port/cli-facade-registry.port.js';
import type { CliTarget, ResolvedCliProfile } from './cli-profile.js';

/**
 * Everything a leaf command needs to execute, assembled by the composition
 * root before the command runs. Commands read from this context only — they
 * do not read `process.env`, open transports, or resolve profiles themselves.
 */
export interface CommandContext {
  readonly target: CliTarget;
  readonly profile: ResolvedCliProfile;
  readonly requestId: string;
  /** Per-request timeout in ms, or `null` when unbounded. */
  readonly timeoutMs: number | null;
  readonly abortSignal: AbortSignal | undefined;
  readonly cwd: string;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly facades: CliFacadeRegistry;
}
