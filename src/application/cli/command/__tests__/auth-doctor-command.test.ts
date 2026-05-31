import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context/command-context.js';
import type {
  AuthDoctorInput,
  AuthDoctorResult,
  AuthLoginResult,
  AuthPathResult,
  AuthRefreshResult,
  AuthStatusResult,
  AuthWhoAmIResult,
} from '../../dto/auth.dto.js';
import type { AuthFacadePort } from '../../port/auth-facade.port.js';
import type { ResolvedCliProfile } from '../../context/cli-profile.js';
import { AuthDoctorCommand } from '../auth/doctor.command.js';
import { EXIT_PROBE } from '../exit-code.js';

interface DoctorCapture {
  readonly input: AuthDoctorInput;
}

function makeAuth(
  capture: { last: DoctorCapture | null },
  response: AuthDoctorResult,
): AuthFacadePort {
  return {
    async status(): Promise<AuthStatusResult> {
      throw new Error('not used');
    },
    async path(): Promise<AuthPathResult> {
      throw new Error('not used');
    },
    async refresh(): Promise<AuthRefreshResult> {
      throw new Error('not used');
    },
    async doctor(input: AuthDoctorInput): Promise<AuthDoctorResult> {
      capture.last = { input };
      return response;
    },
    async login(): Promise<AuthLoginResult> {
      throw new Error('not used');
    },
    async whoami(): Promise<AuthWhoAmIResult> {
      throw new Error('not used');
    },
  };
}

function makeCtx(args: {
  auth: AuthFacadePort;
  profile: ResolvedCliProfile;
}): CommandContext {
  return {
    target: args.profile.target,
    profile: args.profile,
    requestId: 'req-test',
    timeoutMs: null,
    abortSignal: undefined,
    cwd: '/tmp',
    readTextFile: async () => '',
    facades: {
      auth: args.auth,
      search: {} as never,
      agent: {} as never,
    },
  };
}

function healthyProfile(overrides: Partial<ResolvedCliProfile> = {}): ResolvedCliProfile {
  return {
    name: 'test',
    target: 'remote',
    authMode: 'none',
    outputFormat: 'json',
    ...overrides,
  };
}

describe('AuthDoctorCommand', () => {
  const cmd = new AuthDoctorCommand();

  it('omits exitCode when doctor reports healthy', async () => {
    const capture: { last: DoctorCapture | null } = { last: null };
    const doctorResult: AuthDoctorResult = { healthy: true, checks: [] };
    const ctx = makeCtx({
      auth: makeAuth(capture, doctorResult),
      profile: healthyProfile(),
    });

    const result = await cmd.run(ctx, {});

    expect(result.data).toBe(doctorResult);
    expect(result.exitCode).toBeUndefined();
    expect('exitCode' in result).toBe(false);
  });

  it('sets exitCode=EXIT_PROBE when doctor reports unhealthy', async () => {
    const capture: { last: DoctorCapture | null } = { last: null };
    const doctorResult: AuthDoctorResult = {
      healthy: false,
      checks: [{ name: 'auth-file', status: 'fail', detail: 'missing' }],
    };
    const ctx = makeCtx({
      auth: makeAuth(capture, doctorResult),
      profile: healthyProfile(),
    });

    const result = await cmd.run(ctx, {});

    expect(result.data).toBe(doctorResult);
    expect(result.exitCode).toBe(EXIT_PROBE);
  });

  it('forwards baseUrl when present on the profile', async () => {
    const capture: { last: DoctorCapture | null } = { last: null };
    const ctx = makeCtx({
      auth: makeAuth(capture, { healthy: true, checks: [] }),
      profile: healthyProfile({
        target: 'remote',
        baseUrl: 'https://example.com',
        authMode: 'bearer',
      }),
    });

    await cmd.run(ctx, {});

    expect(capture.last?.input).toEqual({
      target: 'remote',
      baseUrl: 'https://example.com',
      authMode: 'bearer',
    });
    expect(capture.last?.input.baseUrl).toBe('https://example.com');
  });

  it('omits baseUrl when absent on the profile', async () => {
    const capture: { last: DoctorCapture | null } = { last: null };
    const ctx = makeCtx({
      auth: makeAuth(capture, { healthy: true, checks: [] }),
      profile: healthyProfile({ target: 'local', authMode: 'codex' }),
    });

    await cmd.run(ctx, {});

    expect(capture.last?.input).toEqual({
      target: 'local',
      authMode: 'codex',
    });
    expect('baseUrl' in (capture.last?.input ?? {})).toBe(false);
  });

  it('parseArgs returns an empty record', () => {
    expect(cmd.parseArgs()).toEqual({});
  });
});
