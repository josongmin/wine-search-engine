import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts/enforce-pnpm-install.mjs');

function runGuard(overrides: Record<string, string | undefined>): { exitCode: number; stderr: string } {
  const env = { ...process.env, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'SKIP_PNPM_ONLY_CHECK')) {
    delete env.SKIP_PNPM_ONLY_CHECK;
  }
  try {
    execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string | Buffer };
    const stderr =
      typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '';
    return { exitCode: e.status ?? 1, stderr };
  }
}

describe('enforce-pnpm-install.mjs', () => {
  it('exits 0 when npm_config_user_agent is pnpm', () => {
    const { exitCode } = runGuard({ npm_config_user_agent: 'pnpm/9.15.9 npm/? node/v22.0.0 darwin arm64' });
    expect(exitCode).toBe(0);
  });

  it('exits 1 when npm_config_user_agent is npm', () => {
    const { exitCode, stderr } = runGuard({ npm_config_user_agent: 'npm/10.8.2 node/v22.0.0 darwin arm64' });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('pnpm only');
  });

  it('exits 1 when npm_config_user_agent is yarn', () => {
    const { exitCode } = runGuard({ npm_config_user_agent: 'yarn/4.5.0 npm/? node/v22.0.0' });
    expect(exitCode).toBe(1);
  });

  it('exits 0 when SKIP_PNPM_ONLY_CHECK=1 even with npm user agent', () => {
    const { exitCode } = runGuard({
      npm_config_user_agent: 'npm/10.8.2 node/v22.0.0',
      SKIP_PNPM_ONLY_CHECK: '1',
    });
    expect(exitCode).toBe(0);
  });
});
