import { describe, expect, it } from 'vitest';
import { runCli } from '../run-cli.js';
import { createDefaultRegistry } from '../command-registry.js';
import type { CliIo } from '../io.js';
import type { CommandContext } from '../../../application/cli/context/command-context.js';
import type { AuthFacadePort } from '../../../application/cli/port/auth-facade.port.js';
import {
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

function fakeContext(
  auth: Partial<AuthFacadePort>,
): CommandContext {
  return {
    target: 'local',
    profile: { name: 'default', target: 'local', authMode: 'codex', outputFormat: 'json' },
    requestId: 'req-test',
    timeoutMs: null,
    abortSignal: undefined,
    cwd: '/tmp',
    readTextFile: () => Promise.resolve(''),
    facades: {
      auth: auth as AuthFacadePort,
      search: { __facade: 'search' } as never,
      wineSearch: { __facade: 'wine-search' } as never,
    },
  };
}

describe('CLI smoke proof rail', () => {
  it('--help prints the deterministic shell text and exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['--help'], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_SUCCESS);

    const out = cap.stdout();
    // Structural help anchors — accidental rewording must surface in CI.
    expect(out).toContain('Usage:');
    expect(out).toContain('Global options:');
    expect(out).toContain('wine <group> <command>');
    expect(out).toContain('--json');
    expect(out).toContain('--target local|remote');

    // Registered command summaries — proves help/registry integration didn't drift.
    expect(out).toContain('auth status');
    expect(out).toContain('auth doctor');
    expect(out).toContain('search run');
    expect(out).toContain('wine-search run');

    // The hidden kernel self-test must NOT appear in the documented surface.
    expect(out).not.toContain('system ping');
  });

  it('bare invocation (no args) prints help and exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli([], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_SUCCESS);
    expect(cap.stdout()).toContain('Usage:');
  });

  it('unknown command exits 2 with a usage error message', async () => {
    const cap = makeCapture();
    const code = await runCli(['nope', 'whoknows'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(cap.stderr()).toContain('Unknown command');
  });

  it('incomplete command path exits 2 with a usage error message', async () => {
    const cap = makeCapture();
    const code = await runCli(['auth'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(cap.stderr()).toContain('Incomplete command');
  });

  it('hidden system ping runs end-to-end (kernel self-test)', async () => {
    const cap = makeCapture();
    const code = await runCli(['system', 'ping', '--json'], {
      io: cap.io,
      registry: createDefaultRegistry(),
    });
    expect(code).toBe(EXIT_SUCCESS);

    const payload = JSON.parse(cap.stdout()) as {
      ok: boolean;
      target: string;
      requestId: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe('local');
    expect(typeof payload.requestId).toBe('string');
  });

  it('auth status runs end-to-end with an injected fake facade', async () => {
    const cap = makeCapture();
    const code = await runCli(['auth', 'status', '--json'], {
      io: cap.io,
      registry: createDefaultRegistry(),
      buildContext: () =>
        fakeContext({
          status: () =>
            Promise.resolve({
              authenticated: true,
              authPath: '/p',
              authMode: 'chatgpt',
              hasAccessToken: true,
              hasRefreshToken: false,
            }),
        }),
    });
    expect(code).toBe(EXIT_SUCCESS);

    const payload = JSON.parse(cap.stdout()) as {
      authenticated: boolean;
      authMode: string;
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.authMode).toBe('chatgpt');
  });

  it('help text invariants lock structural headers (drift gate)', async () => {
    const cap = makeCapture();
    const code = await runCli(['--help'], { io: cap.io, registry: createDefaultRegistry() });
    expect(code).toBe(EXIT_SUCCESS);

    // Exact-line headers from src/interface/cli/render/render-help.ts.
    // Locking each as a standalone line means renaming/dropping a section
    // (e.g. "Commands:" → "Available commands:") surfaces immediately.
    const lines = cap.stdout().split('\n');
    expect(lines).toContain('Usage:');
    expect(lines).toContain('Commands:');
    expect(lines).toContain('Global options:');
    expect(lines).toContain('Examples:');
  });
});
