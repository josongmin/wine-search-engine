import type {
  ProfileStorePort,
  ResolveProfileInput,
} from '../../../application/cli/port/profile-store.port.js';
import type {
  CliAuthMode,
  CliTarget,
  ResolvedCliProfile,
} from '../../../application/cli/context/cli-profile.js';
import { isOutputFormat, type OutputFormat } from '../../../application/cli/port/output-renderer.port.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

const DEFAULT_TARGET: CliTarget = 'local';
const DEFAULT_PROFILE_NAME = 'default';
const DEFAULT_AUTH_MODE: CliAuthMode = 'codex';
const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'human';

/** Env var keys the CLI profile plane reads (lowest precedence above defaults). */
export const CLI_ENV_KEYS = {
  profile: 'WINE_CLI_PROFILE',
  target: 'WINE_CLI_TARGET',
  baseUrl: 'WINE_CLI_BASE_URL',
  timeoutMs: 'WINE_CLI_TIMEOUT_MS',
  authMode: 'WINE_CLI_AUTH_MODE',
  bearerToken: 'WINE_CLI_BEARER_TOKEN',
  output: 'WINE_CLI_OUTPUT',
} as const;

function readEnv(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parseTarget(value: string | undefined): CliTarget | undefined {
  return value === 'local' || value === 'remote' ? value : undefined;
}

function parseAuthMode(value: string | undefined): CliAuthMode | undefined {
  return value === 'codex' || value === 'bearer' || value === 'none' ? value : undefined;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOutput(value: string | undefined): OutputFormat | undefined {
  return value !== undefined && isOutputFormat(value) ? value : undefined;
}

/**
 * Resolves the profile under `flags > env > defaults`. No file-backed store in
 * v1 (architecture decision §9 allows this), but commands still see only the
 * resolved {@link ResolvedCliProfile} so the precedence is centralized here.
 */
export class EnvProfileResolver implements ProfileStorePort {
  constructor(private readonly env: EnvLike = process.env) {}

  resolve(input: ResolveProfileInput): ResolvedCliProfile {
    const { args } = input;
    const env = this.env;

    const target = args.target ?? parseTarget(readEnv(env, CLI_ENV_KEYS.target)) ?? DEFAULT_TARGET;
    const name = args.profile ?? readEnv(env, CLI_ENV_KEYS.profile) ?? DEFAULT_PROFILE_NAME;
    const baseUrl = args.baseUrl ?? readEnv(env, CLI_ENV_KEYS.baseUrl);
    const timeoutMs = args.timeoutMs ?? parseTimeout(readEnv(env, CLI_ENV_KEYS.timeoutMs));
    const authMode =
      args.authMode
      ?? parseAuthMode(readEnv(env, CLI_ENV_KEYS.authMode))
      ?? DEFAULT_AUTH_MODE;
    const bearerToken = args.bearerToken ?? readEnv(env, CLI_ENV_KEYS.bearerToken);
    // The global parser already folded --json/--output into args.output. Env
    // only applies when the flag was left at its 'human' default.
    const outputFormat =
      args.output !== DEFAULT_OUTPUT_FORMAT
        ? args.output
        : parseOutput(readEnv(env, CLI_ENV_KEYS.output)) ?? DEFAULT_OUTPUT_FORMAT;

    return {
      name,
      target,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(timeoutMs != null ? { timeoutMs } : {}),
      authMode,
      ...(bearerToken !== undefined ? { bearerToken } : {}),
      outputFormat,
    };
  }
}
