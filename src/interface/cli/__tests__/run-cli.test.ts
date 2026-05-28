import { describe, expect, it } from 'vitest';
import { runCli } from '../run-cli.js';
import { CommandRegistry, createDefaultRegistry } from '../command-registry.js';
import type { CliIo } from '../io.js';
import type { CliCommand } from '../../../application/cli/command/cli-command.js';
import type { CommandContext } from '../../../application/cli/context/command-context.js';
import type { CommandResult } from '../../../application/cli/context/command-result.js';
import type { AuthFacadePort } from '../../../application/cli/port/auth-facade.port.js';
import type { SearchFacadePort } from '../../../application/cli/port/search-facade.port.js';
import type { EntityFacadePort } from '../../../application/cli/port/entity-facade.port.js';
import type { WineSearchFacadePort } from '../../../application/cli/port/wine-search-facade.port.js';
import type { RawApiInvokerPort } from '../../../application/cli/port/raw-api-invoker.port.js';
import { CliError } from '../../../application/cli/command/cli-error.js';
import {
  EXIT_AUTH,
  EXIT_EXECUTION,
  EXIT_PROBE,
  EXIT_SUCCESS,
  EXIT_USAGE,
} from '../../../application/cli/command/exit-code.js';

function makeCapture(): { io: CliIo; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      write: (chunk: string) => void out.push(chunk),
      writeError: (chunk: string) => void err.push(chunk),
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function throwingCommand(group: string, name: string, error: Error): CliCommand {
  return {
    group,
    name,
    summary: 'throws',
    parseArgs: () => ({}),
    run: (_ctx: CommandContext): Promise<CommandResult> => Promise.reject(error),
  };
}

function fakeContext(
  auth: Partial<AuthFacadePort>,
  overrides: Partial<{
    search: SearchFacadePort;
    entity: EntityFacadePort;
    wineSearch: WineSearchFacadePort;
    rawApi: RawApiInvokerPort;
    readTextFile: (path: string) => Promise<string>;
  }> = {},
): CommandContext {
  return {
    target: 'local',
    profile: { name: 'default', target: 'local', authMode: 'codex', outputFormat: 'json' },
    requestId: 'req-test',
    timeoutMs: null,
    abortSignal: undefined,
    cwd: '/tmp',
    readTextFile: overrides.readTextFile ?? (() => Promise.resolve('')),
    facades: {
      auth: auth as AuthFacadePort,
      search:
        overrides.search
        ?? ({
          run: () => Promise.resolve({ ok: true }),
          hybrid: () => Promise.resolve({ ok: true }),
        } as SearchFacadePort),
      entity:
        overrides.entity
        ?? ({
          resolve: () => Promise.resolve({ status: 'ok', candidates: [], topEntity: null, decision_trace_ref: 'd', authority_trace_ref: 'a' }),
          autocomplete: () => Promise.resolve({ status: 'ok', suggestions: [], decision_trace_ref: 'd', authority_trace_ref: 'a' }),
        } as EntityFacadePort),
      wineSearch:
        overrides.wineSearch
        ?? ({
          run: () => Promise.resolve({ answer: 'ok' }),
        } as WineSearchFacadePort),
      rawApi:
        overrides.rawApi
        ?? ({
          call: () => Promise.resolve({ status: 200, statusText: 'OK', headers: {}, body: {} }),
          openApi: () => Promise.resolve({ path: '/openapi.json', document: {} }),
        } as RawApiInvokerPort),
    },
  };
}

describe('runCli', () => {
  it('prints help and exits 0 for --help', async () => {
    const cap = makeCapture();
    const code = await runCli(['--help'], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_SUCCESS);
    expect(cap.stdout()).toContain('Usage:');
    expect(cap.stdout()).toContain('Global options:');
  });

  it('prints help and exits 0 for a bare invocation', async () => {
    const cap = makeCapture();
    const code = await runCli([], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_SUCCESS);
    expect(cap.stdout()).toContain('Usage:');
  });

  it('runs the hidden ping command end-to-end and renders JSON', async () => {
    const cap = makeCapture();
    const code = await runCli(['system', 'ping', '--json'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_SUCCESS);
    const payload = JSON.parse(cap.stdout()) as {
      ok: boolean;
      target: string;
      requestId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe('local');
    expect(payload.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('threads global target and leaf args into the command result', async () => {
    const cap = makeCapture();
    const code = await runCli(['system', 'ping', '--target', 'remote', '--note', 'hey', '--json'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_SUCCESS);
    const payload = JSON.parse(cap.stdout()) as { target: string; note?: string };
    expect(payload.target).toBe('remote');
    expect(payload.note).toBe('hey');
  });

  it('exits with usage code for an unknown command', async () => {
    const cap = makeCapture();
    const code = await runCli(['nope', 'whoknows'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(cap.stderr()).toContain('Unknown command');
  });

  it('exits with usage code for an incomplete command path', async () => {
    const cap = makeCapture();
    const code = await runCli(['auth'], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_USAGE);
    expect(cap.stderr()).toContain('Incomplete command');
  });

  it('exits with usage code for an invalid global option value', async () => {
    const cap = makeCapture();
    const code = await runCli(['--output', 'bogus', 'system', 'ping'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(cap.stderr()).toContain('Invalid --output');
  });

  it('maps a thrown CliError to its semantic exit code', async () => {
    const registry = new CommandRegistry();
    registry.register(throwingCommand('auth', 'login', CliError.auth('login failed')));
    const cap = makeCapture();
    const code = await runCli(['auth', 'login'], { io: cap.io, registry });
    expect(code).toBe(EXIT_AUTH);
    expect(cap.stderr()).toContain('login failed');
  });

  it('maps an unexpected error to the execution exit code', async () => {
    const registry = new CommandRegistry();
    registry.register(throwingCommand('search', 'run', new Error('boom')));
    const cap = makeCapture();
    const code = await runCli(['search', 'run'], { io: cap.io, registry });
    expect(code).toBe(EXIT_EXECUTION);
    expect(cap.stderr()).toContain('boom');
  });

  it('runs auth status through the shell with an injected facade', async () => {
    const cap = makeCapture();
    const code = await runCli(['auth', 'status', '--json'], {
      io: cap.io,
      buildContext: () =>
        fakeContext({
          status: () =>
            Promise.resolve({
              authenticated: true,
              authPath: '/p/auth.json',
              authMode: 'chatgpt',
              hasAccessToken: true,
              hasRefreshToken: false,
            }),
        }),
    });
    expect(code).toBe(EXIT_SUCCESS);
    const payload = JSON.parse(cap.stdout()) as { authenticated: boolean; authMode: string };
    expect(payload.authenticated).toBe(true);
    expect(payload.authMode).toBe('chatgpt');
  });

  it('auth doctor exits with the probe code when unhealthy', async () => {
    const cap = makeCapture();
    const code = await runCli(['auth', 'doctor', '--json'], {
      io: cap.io,
      buildContext: () =>
        fakeContext({
          doctor: () =>
            Promise.resolve({ healthy: false, checks: [{ name: 'auth_file', status: 'fail' }] }),
        }),
    });
    expect(code).toBe(EXIT_PROBE);
  });

  it('runs search run through the shell with an injected typed facade', async () => {
    const cap = makeCapture();
    const code = await runCli(['search', 'run', '--q', 'opus one 2018', '--json'], {
      io: cap.io,
      buildContext: () =>
        fakeContext(
          {},
          {
            search: {
              run: (input) => Promise.resolve({ echoed_query: input.query }),
              hybrid: () => Promise.resolve({}),
            },
          },
        ),
    });
    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(cap.stdout())).toEqual({ echoed_query: 'opus one 2018' });
  });

  it('loads @file body in api call and returns execution exit code on http error', async () => {
    const cap = makeCapture();
    const code = await runCli(['api', 'call', 'POST', '/v1/search', '--body', '@/tmp/req.json', '--json'], {
      io: cap.io,
      buildContext: () =>
        fakeContext(
          {},
          {
            readTextFile: () => Promise.resolve('{"query":"opus one"}'),
            rawApi: {
              call: (_input) =>
                Promise.resolve({
                  status: 422,
                  statusText: 'Unprocessable Entity',
                  headers: { 'content-type': 'application/json' },
                  body: { error: 'bad' },
                  rawText: '{"error":"bad"}',
                }),
              openApi: () => Promise.resolve({ path: '/openapi.json', document: {} }),
            },
          },
        ),
    });
    expect(code).toBe(EXIT_EXECUTION);
    const payload = JSON.parse(cap.stdout()) as { status: number; body: { error: string } };
    expect(payload.status).toBe(422);
    expect(payload.body.error).toBe('bad');
  });
});
