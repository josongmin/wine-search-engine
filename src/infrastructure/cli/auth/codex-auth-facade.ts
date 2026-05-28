import type { AuthFacadePort } from '../../../application/cli/port/auth-facade.port.js';
import type {
  AuthDoctorCheck,
  AuthDoctorCheckStatus,
  AuthDoctorInput,
  AuthDoctorResult,
  AuthLoginResult,
  AuthPathResult,
  AuthRefreshResult,
  AuthStatusResult,
  AuthWhoAmIResult,
} from '../../../application/cli/dto/auth.dto.js';
import { CliError } from '../../../application/cli/command/cli-error.js';
import type {
  CodexAuthRecordStore,
  CodexLoginDelegate,
  CodexModelCatalogProbe,
} from './codex-auth-ports.js';

function check(name: string, status: AuthDoctorCheckStatus, detail?: string): AuthDoctorCheck {
  return detail !== undefined ? { name, status, detail } : { name, status };
}

function hasRefreshToken(refreshToken: string | undefined): boolean {
  return refreshToken !== undefined && refreshToken.length > 0;
}

/**
 * Codex-backed implementation of {@link AuthFacadePort}. Composes the record
 * store, model-catalog probe, and login delegate. Target-independent: auth is
 * about the local Codex token regardless of local/remote execution.
 */
export class CodexAuthFacade implements AuthFacadePort {
  constructor(
    private readonly store: CodexAuthRecordStore,
    private readonly probe: CodexModelCatalogProbe,
    private readonly loginDelegate: CodexLoginDelegate,
  ) {}

  async status(): Promise<AuthStatusResult> {
    const authPath = this.store.authPath();
    const record = await this.store.read();
    if (record === null) {
      return {
        authenticated: false,
        authPath,
        authMode: null,
        hasAccessToken: false,
        hasRefreshToken: false,
      };
    }
    const identity = this.store.identity(record);
    return {
      authenticated: true,
      authPath,
      authMode: 'chatgpt',
      hasAccessToken: record.accessToken.length > 0,
      hasRefreshToken: hasRefreshToken(record.refreshToken),
      ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
    };
  }

  path(): Promise<AuthPathResult> {
    return Promise.resolve({
      path: this.store.authPath(),
      exists: this.store.authFileExists(),
    });
  }

  async refresh(): Promise<AuthRefreshResult> {
    const record = await this.store.read();
    if (record === null) {
      throw CliError.auth('No Codex auth record found; cannot refresh. Run `codex login` first.');
    }
    if (!hasRefreshToken(record.refreshToken)) {
      throw CliError.auth('Codex auth record has no refresh token; cannot refresh.');
    }
    let refreshed;
    try {
      refreshed = await this.store.refresh(record);
    } catch (error) {
      throw CliError.auth(
        `Codex auth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const identity = this.store.identity(refreshed);
    return {
      refreshed: true,
      authPath: refreshed.path,
      ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
    };
  }

  async doctor(input: AuthDoctorInput): Promise<AuthDoctorResult> {
    const checks: AuthDoctorCheck[] = [];

    const authPath = this.store.authPath();
    checks.push(check('auth_file', this.store.authFileExists() ? 'ok' : 'fail', authPath));

    const record = await this.store.read();
    // read() returns non-null only when auth_mode=chatgpt and a non-empty
    // access_token is present, so a null record fails both checks below.
    checks.push(
      check(
        'auth_mode_chatgpt',
        record !== null ? 'ok' : 'fail',
        record !== null ? 'chatgpt' : 'auth_mode is not chatgpt or file is unreadable',
      ),
    );
    checks.push(check('access_token', record !== null && record.accessToken.length > 0 ? 'ok' : 'fail'));

    const refreshOk = record !== null && hasRefreshToken(record.refreshToken);
    checks.push(check('refresh_token', refreshOk ? 'ok' : 'warn', refreshOk ? undefined : 'no refresh token; token cannot be auto-renewed'));
    // refresh capability == refresh token presence. doctor never rotates the
    // token (non-destructive diagnostic), so it does not perform a real refresh.
    checks.push(check('refresh_capable', refreshOk ? 'ok' : 'warn'));

    if (record !== null && record.accessToken.length > 0) {
      const result = await this.probe.probe(record);
      checks.push(
        check(
          'model_catalog_probe',
          result.ok ? 'ok' : 'fail',
          result.ok ? `${result.modelCount} models (HTTP ${result.status})` : result.error ?? `HTTP ${result.status}`,
        ),
      );
    } else {
      checks.push(check('model_catalog_probe', 'fail', 'skipped: no access token to present'));
    }

    if (input.target === 'remote') {
      const baseUrlOk = input.baseUrl !== undefined && input.baseUrl.length > 0;
      checks.push(check('remote_base_url', baseUrlOk ? 'ok' : 'fail', baseUrlOk ? input.baseUrl : 'target=remote requires a base URL'));
      const authModeOk = input.authMode !== 'none';
      checks.push(check('remote_auth_mode', authModeOk ? 'ok' : 'warn', `authMode=${input.authMode}`));
    }

    const healthy = !checks.some((entry) => entry.status === 'fail');
    return { healthy, checks };
  }

  async login(): Promise<AuthLoginResult> {
    const record = await this.store.read();
    return this.loginDelegate.describe(record !== null);
  }

  async whoami(): Promise<AuthWhoAmIResult> {
    const authPath = this.store.authPath();
    const record = await this.store.read();
    if (record === null) {
      return { authenticated: false, authPath };
    }
    const identity = this.store.identity(record);
    return {
      authenticated: true,
      authPath,
      ...(identity.accountId !== undefined ? { accountId: identity.accountId } : {}),
      ...(identity.email !== undefined ? { email: identity.email } : {}),
    };
  }
}
