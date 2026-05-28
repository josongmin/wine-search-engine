import { describe, expect, it } from 'vitest';
import { CLI_ENV_KEYS, EnvProfileResolver } from '../env-profile-resolver.js';
import type { GlobalArgs } from '../../../../application/cli/context/global-args.js';

function args(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return { help: false, output: 'human', timeoutMs: null, verbose: false, debug: false, ...overrides };
}

describe('EnvProfileResolver', () => {
  it('uses defaults when neither flags nor env are set', () => {
    const profile = new EnvProfileResolver({}).resolve({ args: args() });
    expect(profile).toEqual({
      name: 'default',
      target: 'local',
      authMode: 'codex',
      outputFormat: 'human',
    });
  });

  it('applies env when flags are absent', () => {
    const env = {
      [CLI_ENV_KEYS.target]: 'remote',
      [CLI_ENV_KEYS.baseUrl]: 'https://env.example.com',
      [CLI_ENV_KEYS.output]: 'yaml',
      [CLI_ENV_KEYS.authMode]: 'bearer',
      [CLI_ENV_KEYS.bearerToken]: 'env-token',
    };
    const profile = new EnvProfileResolver(env).resolve({ args: args() });
    expect(profile.target).toBe('remote');
    expect(profile.baseUrl).toBe('https://env.example.com');
    expect(profile.outputFormat).toBe('yaml');
    expect(profile.authMode).toBe('bearer');
    expect(profile.bearerToken).toBe('env-token');
  });

  it('lets flags win over env (precedence)', () => {
    const env = { [CLI_ENV_KEYS.target]: 'remote', [CLI_ENV_KEYS.baseUrl]: 'https://env' };
    const profile = new EnvProfileResolver(env).resolve({
      args: args({ target: 'local', baseUrl: 'https://flag', output: 'json', bearerToken: 'flag-token' }),
    });
    expect(profile.target).toBe('local');
    expect(profile.baseUrl).toBe('https://flag');
    expect(profile.outputFormat).toBe('json');
    expect(profile.bearerToken).toBe('flag-token');
  });

  it('ignores invalid env values and falls back to defaults', () => {
    const env = {
      [CLI_ENV_KEYS.target]: 'prod',
      [CLI_ENV_KEYS.timeoutMs]: 'abc',
      [CLI_ENV_KEYS.authMode]: 'weird',
    };
    const profile = new EnvProfileResolver(env).resolve({ args: args() });
    expect(profile.target).toBe('local');
    expect(profile.timeoutMs).toBeUndefined();
    expect(profile.authMode).toBe('codex');
  });

  it('parses a positive timeout from env, flags still win', () => {
    const env = { [CLI_ENV_KEYS.timeoutMs]: '3000' };
    expect(new EnvProfileResolver(env).resolve({ args: args() }).timeoutMs).toBe(3000);
    expect(new EnvProfileResolver(env).resolve({ args: args({ timeoutMs: 9000 }) }).timeoutMs).toBe(9000);
  });
});
