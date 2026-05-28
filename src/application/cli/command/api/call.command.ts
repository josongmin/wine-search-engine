import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import type {
  RawApiHeaderInput,
  RawApiQueryParamInput,
} from '../../dto/raw-api.dto.js';
import { CliError } from '../cli-error.js';
import { EXIT_EXECUTION } from '../exit-code.js';
import {
  expectFlagValue,
  parseHeaderAssignment,
  resolveBodySpec,
} from '../command-arg-utils.js';

const HTTP_BAD_REQUEST = 400;

interface ApiCallArgs {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly RawApiHeaderInput[];
  readonly query: readonly RawApiQueryParamInput[];
  readonly body?: string;
  readonly contentType?: string;
  readonly showHeaders: boolean;
}

export class ApiCallCommand implements CliCommand<ApiCallArgs> {
  readonly group = 'api';
  readonly name = 'call';
  readonly summary = 'Call an arbitrary HTTP route against the configured target.';

  parseArgs(rawArgs: readonly string[]): ApiCallArgs {
    const method = rawArgs[0];
    const path = rawArgs[1];
    if (method === undefined || path === undefined) {
      throw CliError.usage('api call requires METHOD and PATH');
    }

    const headers: RawApiHeaderInput[] = [];
    const query: RawApiQueryParamInput[] = [];
    let body: string | undefined;
    let contentType: string | undefined;
    let showHeaders = false;

    for (let i = 2; i < rawArgs.length; i += 1) {
      const token = rawArgs[i];
      switch (token) {
        case '--header': {
          const parsed = parseHeaderAssignment(expectFlagValue(rawArgs, i, token), token);
          headers.push(parsed);
          i += 1;
          break;
        }
        case '--query-param': {
          const parsed = parseHeaderAssignment(expectFlagValue(rawArgs, i, token), token);
          query.push(parsed);
          i += 1;
          break;
        }
        case '--body':
          body = expectFlagValue(rawArgs, i, token);
          i += 1;
          break;
        case '--content-type':
          contentType = expectFlagValue(rawArgs, i, token);
          i += 1;
          break;
        case '--show-headers':
          showHeaders = true;
          break;
        default:
          throw CliError.usage(`Unknown api call option "${token}"`);
      }
    }

    return {
      method,
      path,
      headers,
      query,
      ...(body !== undefined ? { body } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      showHeaders,
    };
  }

  async run(ctx: CommandContext, args: ApiCallArgs): Promise<CommandResult> {
    const bodyText = await resolveBodySpec(ctx, args.body);
    const result = await ctx.facades.rawApi.call(
      {
        method: args.method,
        path: args.path,
        headers: args.headers,
        query: args.query,
        ...(bodyText !== undefined ? { bodyText } : {}),
        ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
      },
      {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      },
    );
    return {
      data: {
        ...result,
        showHeaders: args.showHeaders,
      },
      renderAs: 'raw-api',
      ...(result.status >= HTTP_BAD_REQUEST ? { exitCode: EXIT_EXECUTION } : {}),
    };
  }
}
