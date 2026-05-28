import type { GlobalArgs } from '../../../application/cli/context/global-args.js';
import type { CliAuthMode, CliTarget } from '../../../application/cli/context/cli-profile.js';
import { isOutputFormat, type OutputFormat } from '../../../application/cli/port/output-renderer.port.js';
import { CliError } from '../../../application/cli/command/cli-error.js';

export interface ParsedArgv {
  readonly global: GlobalArgs;
  /** Tokens not consumed as global options, in original order (command path + leaf args). */
  readonly rest: readonly string[];
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw CliError.usage(`Missing value for ${flag}`);
  }
  return value;
}

function parseTarget(value: string): CliTarget {
  if (value === 'local' || value === 'remote') {
    return value;
  }
  throw CliError.usage(`Invalid --target "${value}" (expected local|remote)`);
}

function parseAuthMode(value: string): CliAuthMode {
  if (value === 'codex' || value === 'bearer' || value === 'none') {
    return value;
  }
  throw CliError.usage(`Invalid --auth-mode "${value}" (expected codex|bearer|none)`);
}

function parseTimeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw CliError.usage(`Invalid --timeout-ms "${value}" (expected a positive number of ms)`);
  }
  return parsed;
}

/**
 * Parses the global option plane (architecture decision §7). Global options
 * may appear anywhere on the line; unrecognized tokens — including leaf-command
 * flags — fall through to `rest` untouched so each leaf owns its own parser.
 */
export function parseGlobalArgs(argv: readonly string[]): ParsedArgv {
  let help = false;
  let target: CliTarget | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let authMode: CliAuthMode | undefined;
  let bearerToken: string | undefined;
  let output: OutputFormat = 'human';
  let requestId: string | undefined;
  let timeoutMs: number | null = null;
  let verbose = false;
  let debug = false;
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }
    switch (token) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--json':
        output = 'json';
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--target':
        target = parseTarget(expectValue(token, argv[i + 1]));
        i += 1;
        break;
      case '--profile':
        profile = expectValue(token, argv[i + 1]);
        i += 1;
        break;
      case '--base-url':
        baseUrl = expectValue(token, argv[i + 1]);
        i += 1;
        break;
      case '--auth-mode':
        authMode = parseAuthMode(expectValue(token, argv[i + 1]));
        i += 1;
        break;
      case '--bearer-token':
        bearerToken = expectValue(token, argv[i + 1]);
        i += 1;
        break;
      case '--output': {
        const value = expectValue(token, argv[i + 1]);
        if (!isOutputFormat(value)) {
          throw CliError.usage(`Invalid --output "${value}" (expected human|json|table|yaml|raw)`);
        }
        output = value;
        i += 1;
        break;
      }
      case '--request-id':
        requestId = expectValue(token, argv[i + 1]);
        i += 1;
        break;
      case '--timeout-ms':
        timeoutMs = parseTimeoutMs(expectValue(token, argv[i + 1]));
        i += 1;
        break;
      default:
        rest.push(token);
    }
    i += 1;
  }

  const global: GlobalArgs = {
    help,
    output,
    timeoutMs,
    verbose,
    debug,
    ...(target !== undefined ? { target } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
    ...(bearerToken !== undefined ? { bearerToken } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
  return { global, rest };
}
