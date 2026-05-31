import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Black-box e2e for the `wine` CLI: spawns the real entrypoint as a child
 * process (through tsx, from source) and asserts stdout/stderr/exit code at the
 * process boundary. This exercises the parts unit tests calling `runCli()`
 * directly cannot: the shebang/entrypoint, `process.exitCode` propagation, and
 * the actual argv → kernel → render → exit path end to end.
 *
 * The offline cases need no external services and run in CI. The live block is
 * gated behind WINE_CLI_LIVE_E2E=1 (it builds the real container and hits RDS).
 */

const execFileAsync = promisify(execFile);
const TSX_BIN = 'node_modules/.bin/tsx';
const CLI_ENTRY = 'src/interface/cli/main.ts';
const PROC_TIMEOUT_MS = 25_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      timeout: PROC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('wine CLI (process boundary, offline)', () => {
  it('--help prints the command tree and exits 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('Global options:');
    for (const cmd of ['auth status', 'search hybrid', 'lookup wine', 'agent run']) {
      expect(r.stdout).toContain(cmd);
    }
    // hidden kernel self-test must not surface in the help tree
    expect(r.stdout).not.toContain('system ping');
  });

  it('bare invocation prints help and exits 0', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('unknown command exits 2 with a usage error', async () => {
    const r = await runCli(['nope', 'whoknows']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command');
  });

  it('incomplete command path exits 2', async () => {
    const r = await runCli(['auth']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Incomplete command');
  });

  it('invalid global option value exits 2', async () => {
    const r = await runCli(['--output', 'bogus', 'system', 'ping']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Invalid --output');
  });

  it('hidden system ping runs end-to-end and emits JSON', async () => {
    const r = await runCli(['system', 'ping', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; target: string; requestId: string };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe('local');
    expect(payload.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('ignores a leading argv sentinel and still executes the command', async () => {
    const r = await runCli(['--', 'system', 'ping', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; target: string; requestId: string };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe('local');
    expect(payload.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('auth path reports the Codex auth file location (exit 0)', async () => {
    const r = await runCli(['auth', 'path', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { path: string; exists: boolean };
    expect(payload.path).toContain('auth.json');
    expect(typeof payload.exists).toBe('boolean');
  });
});

const LIVE_E2E = process.env['WINE_CLI_LIVE_E2E'] === '1';

describe.skipIf(!LIVE_E2E)('wine CLI live (gated: WINE_CLI_LIVE_E2E=1, needs real RDS)', () => {
  // Entity-lookup routes through the PG/RDS alias snapshot, so it does NOT need
  // the Vespa retrieval channel — keeping this case fast and robust to the
  // Vespa SG allowlist state. (The hybrid/Vespa retrieval path is verified
  // manually when the runner IP is allowlisted; see tools.product-cli catalog.)
  it('lookup wine --target local resolves a known wine end-to-end', async () => {
    const r = await runCli(['lookup', 'wine', '--target', 'local', '--q', 'opus one 2018', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { query_type: string; result_type?: string };
    expect(payload.query_type).toBe('search');
  }, 120_000);
});
