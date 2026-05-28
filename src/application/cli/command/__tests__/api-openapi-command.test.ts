import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context/command-context.js';
import type {
  OpenApiDocumentResult,
  RawApiCallInput,
  RawApiCallResult,
} from '../../dto/raw-api.dto.js';
import type { CliFacadeRequestOptions } from '../../port/facade-request-options.port.js';
import type { RawApiInvokerPort } from '../../port/raw-api-invoker.port.js';
import { ApiOpenApiCommand } from '../api/openapi.command.js';
import { CliError } from '../cli-error.js';

interface OpenApiCapture {
  readonly options: CliFacadeRequestOptions;
}

function makeRawApi(
  capture: { last: OpenApiCapture | null },
  response: OpenApiDocumentResult,
): RawApiInvokerPort {
  return {
    async call(_input: RawApiCallInput): Promise<RawApiCallResult> {
      throw new Error('not used');
    },
    async openApi(options: CliFacadeRequestOptions): Promise<OpenApiDocumentResult> {
      capture.last = { options };
      return response;
    },
  };
}

function makeCtx(rawApi: RawApiInvokerPort): CommandContext {
  return {
    target: 'remote',
    profile: {
      name: 'test',
      target: 'remote',
      authMode: 'none',
      outputFormat: 'json',
    },
    requestId: 'req-test',
    timeoutMs: null,
    abortSignal: undefined,
    cwd: '/tmp',
    readTextFile: async () => '',
    facades: {
      auth: {} as never,
      search: {} as never,
      entity: {} as never,
      wineSearch: {} as never,
      rawApi,
    },
  };
}

describe('ApiOpenApiCommand.parseArgs', () => {
  const cmd = new ApiOpenApiCommand();

  it('returns an empty record for no args', () => {
    expect(cmd.parseArgs([])).toEqual({});
  });

  it('throws CliError(usage) on unknown option', () => {
    try {
      cmd.parseArgs(['--bogus']);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('Unknown api openapi option');
    }
  });
});

describe('ApiOpenApiCommand.run', () => {
  const cmd = new ApiOpenApiCommand();

  it('forwards the openApi call and returns the result as data', async () => {
    const capture: { last: OpenApiCapture | null } = { last: null };
    const document: OpenApiDocumentResult = {
      path: '/openapi.json',
      document: { openapi: '3.0.0' },
    };
    const ctx = makeCtx(makeRawApi(capture, document));

    const result = await cmd.run(ctx, {});

    expect(result.data).toBe(document);
    expect(capture.last?.options.requestId).toBe('req-test');
  });

  it('passes the ctx abortSignal through to the facade', async () => {
    const capture: { last: OpenApiCapture | null } = { last: null };
    const document: OpenApiDocumentResult = {
      path: '/openapi.json',
      document: {},
    };
    const ctx = makeCtx(makeRawApi(capture, document));

    await cmd.run(ctx, {});

    expect(capture.last?.options.abortSignal).toBeUndefined();
    expect(capture.last?.options.requestId).toBe('req-test');
  });
});
