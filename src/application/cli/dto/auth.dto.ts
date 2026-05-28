import type { CliAuthMode, CliTarget } from '../context/cli-profile.js';

export interface AuthStatusResult {
  readonly authenticated: boolean;
  readonly authPath: string;
  readonly authMode: 'chatgpt' | null;
  readonly hasAccessToken: boolean;
  readonly hasRefreshToken: boolean;
  readonly accountId?: string;
}

export interface AuthPathResult {
  readonly path: string;
  readonly exists: boolean;
}

export interface AuthRefreshResult {
  readonly refreshed: boolean;
  readonly authPath: string;
  readonly accountId?: string;
}

export type AuthDoctorCheckStatus = 'ok' | 'warn' | 'fail';

export interface AuthDoctorCheck {
  readonly name: string;
  readonly status: AuthDoctorCheckStatus;
  readonly detail?: string;
}

/** Profile slice doctor needs to verify remote target consistency (check #7). */
export interface AuthDoctorInput {
  readonly target: CliTarget;
  readonly baseUrl?: string;
  readonly authMode: CliAuthMode;
}

export interface AuthDoctorResult {
  readonly healthy: boolean;
  readonly checks: readonly AuthDoctorCheck[];
}

export interface AuthLoginResult {
  /** Always false: the CLI delegates login to Codex; it never owns OAuth. */
  readonly delegated: boolean;
  /** Whether a delegation path is applicable in the current environment. */
  readonly supported: boolean;
  readonly alreadyAuthenticated: boolean;
  readonly delegateCommand: string;
  readonly message: string;
}

export interface AuthWhoAmIResult {
  readonly authenticated: boolean;
  readonly authPath: string;
  readonly accountId?: string;
  readonly email?: string;
}
