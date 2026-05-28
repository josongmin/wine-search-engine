import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context/command-context.js';
import type {
  OpenApiDocumentResult,
  RawApiCallInput,
  RawApiCallResult,
} from '../../dto/raw-api.dto.js';
import type { RawApiInvokerPort } from '../../port/raw-api-invoker.port.js';
import { ApiCallCommand } from '../api/call.command.js';
import { CliError } from '../cli-error.js';
import { EXIT_EXECUTION } from '../exit-code.js';

interface CallCapture {
  readonly input: RawApiCallInput;
}

function makeRawApi(
  capture: { last: CallCapture | null },
  response: RawApiCallResult,
): RawApiInvokerPort {
  return {
    async call(input: RawApiCallInput): Promise<RawApiCallResult> {
      capture.last = { input };
      return response;
    },
    async openApi(): Promise<OpenApiDocumentResult> {
      return { path: '/openapi.json', document: {} };
    },
  };
}

function makeCtx(args: {
  readTextFile?: (p: string) => Promise<string>;
  rawApi: RawApiInvokerPort;
}): CommandContext {
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
    readTextFile: args.readTextFile ?? (async () => ''),
    facades: {
      auth: {} as never,
      search: {} as never,
      entity: {} as never,
      wineSearch: {} as never,
      rawApi: args.rawApi,
    },
  };
}

function okResult(overrides: Partial<RawApiCallResult> = {}): RawApiCallResult {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: {},
    rawText: '',
    ...overrides,
  };
}

describe('ApiCallCommand.parseArgs', () => {
  const cmd = new ApiCallCommand();

  it('throws CliError(usage) when METHOD or PATH is missing', () => {
    try {
      cmd.parseArgs([]);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
    }

    try {
      cmd.parseArgs(['GET']);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
    }
  });

  it('returns minimal args for just METHOD + PATH', () => {
    const args = cmd.parseArgs(['GET', '/health']);
    expect(args).toEqual({
      method: 'GET',
      path: '/health',
      headers: [],
      query: [],
      showHeaders: false,
    });
  });

  it('collects multiple --header flags in order', () => {
    const args = cmd.parseArgs([
      'POST',
      '/v1/x',
      '--header',
      'x-a=1',
      '--header',
      'x-b=2',
    ]);
    expect(args.headers).toEqual([
      { name: 'x-a', value: '1' },
      { name: 'x-b', value: '2' },
    ]);
  });

  it('collects --query-param entries', () => {
    const args = cmd.parseArgs(['POST', '/v1/x', '--query-param', 'k=v']);
    expect(args.query).toEqual([{ name: 'k', value: 'v' }]);
  });

  it('captures --body and --content-type', () => {
    const args = cmd.parseArgs([
      'POST',
      '/v1/x',
      '--body',
      'literal-body',
      '--content-type',
      'application/json',
    ]);
    expect(args.body).toBe('literal-body');
    expect(args.contentType).toBe('application/json');
  });

  it('sets showHeaders=true with --show-headers', () => {
    const args = cmd.parseArgs(['POST', '/v1/x', '--show-headers']);
    expect(args.showHeaders).toBe(true);
  });

  it('throws CliError(usage) on unknown option', () => {
    try {
      cmd.parseArgs(['POST', '/v1/x', '--bogus']);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('Unknown api call option');
    }
  });
});

describe('ApiCallCommand.run', () => {
  const cmd = new ApiCallCommand();

  it('resolves @file bodies via ctx.readTextFile and forwards bodyText', async () => {
    const capture: { last: CallCapture | null } = { last: null };
    const rawApi = makeRawApi(capture, okResult());
    const ctx = makeCtx({
      rawApi,
      readTextFile: async () => '{"q":"x"}',
    });

    await cmd.run(ctx, {
      method: 'POST',
      path: '/v1/x',
      headers: [],
      query: [],
      body: '@req.json',
      showHeaders: false,
    });

    expect(capture.last?.input.bodyText).toBe('{"q":"x"}');
  });

  it('omits exitCode and merges showHeaders into data on 2xx', async () => {
    const capture: { last: CallCapture | null } = { last: null };
    const rawApi = makeRawApi(
      capture,
      okResult({ status: 200, statusText: 'OK', headers: { 'x-y': '1' }, body: { ok: true } }),
    );
    const ctx = makeCtx({ rawApi });

    const result = await cmd.run(ctx, {
      method: 'GET',
      path: '/health',
      headers: [],
      query: [],
      showHeaders: true,
    });

    expect(result.renderAs).toBe('raw-api');
    expect(result.exitCode).toBeUndefined();
    expect('exitCode' in result).toBe(false);
    expect(result.data).toMatchObject({
      status: 200,
      statusText: 'OK',
      headers: { 'x-y': '1' },
      body: { ok: true },
      showHeaders: true,
    });
  });

  it('sets exitCode=EXIT_EXECUTION on a 404 response', async () => {
    const capture: { last: CallCapture | null } = { last: null };
    const rawApi = makeRawApi(
      capture,
      okResult({ status: 404, statusText: 'Not Found' }),
    );
    const ctx = makeCtx({ rawApi });

    const result = await cmd.run(ctx, {
      method: 'GET',
      path: '/missing',
      headers: [],
      query: [],
      showHeaders: false,
    });

    expect(result.exitCode).toBe(EXIT_EXECUTION);
  });

  it('sets exitCode=EXIT_EXECUTION on a 500 response', async () => {
    const capture: { last: CallCapture | null } = { last: null };
    const rawApi = makeRawApi(
      capture,
      okResult({ status: 500, statusText: 'Server Error' }),
    );
    const ctx = makeCtx({ rawApi });

    const result = await cmd.run(ctx, {
      method: 'GET',
      path: '/boom',
      headers: [],
      query: [],
      showHeaders: false,
    });

    expect(result.exitCode).toBe(EXIT_EXECUTION);
  });
});
