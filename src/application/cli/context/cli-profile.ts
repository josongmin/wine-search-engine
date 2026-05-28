import type { OutputFormat } from '../port/output-renderer.port.js';

/**
 * Runtime target for a CLI command.
 *
 * - `local`  : in-process execution via `createContainer()` usecase ports.
 * - `remote` : HTTP execution against a deployed base URL.
 *
 * The kernel only knows the target; how each target resolves to a facade
 * registry is the composition root's concern (see `cli-container.ts`).
 */
export type CliTarget = 'local' | 'remote';

/**
 * How the CLI obtains an auth credential for a request.
 * `codex` delegates to the Codex-owned token store (the auth SSOT);
 * `bearer` uses an explicit token; `none` issues unauthenticated calls.
 *
 * The resolver that populates this lives in T-CLI-02. The kernel only
 * carries the resolved shape so commands never recompute precedence.
 */
export type CliAuthMode = 'codex' | 'bearer' | 'none';

/**
 * Fully-resolved profile a command runs under. Resolution precedence
 * (`flags > env > profile store > defaults`) is owned by the profile
 * resolver ([[env-profile-resolver]]); commands and facades only ever read
 * this shape.
 */
export interface ResolvedCliProfile {
  readonly name: string;
  readonly target: CliTarget;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly authMode: CliAuthMode;
  readonly bearerToken?: string;
  readonly outputFormat: OutputFormat;
}
