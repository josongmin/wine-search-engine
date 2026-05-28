import type { CliTarget } from './cli-profile.js';
import type { OutputFormat } from '../port/output-renderer.port.js';

/**
 * Normalized global options shared by every command, produced by the shell's
 * global-args parser and consumed by the composition root. Leaf commands
 * never see raw argv for these — they read the resolved context instead.
 */
export interface GlobalArgs {
  readonly help: boolean;
  readonly target?: CliTarget;
  readonly profile?: string;
  readonly baseUrl?: string;
  readonly authMode?: 'codex' | 'bearer' | 'none';
  readonly bearerToken?: string;
  readonly output: OutputFormat;
  readonly requestId?: string;
  /** Resolved per-request timeout in ms, or `null` when unbounded. */
  readonly timeoutMs: number | null;
  readonly verbose: boolean;
  readonly debug: boolean;
}
