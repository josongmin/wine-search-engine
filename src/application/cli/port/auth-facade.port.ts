import type {
  AuthDoctorInput,
  AuthDoctorResult,
  AuthLoginResult,
  AuthPathResult,
  AuthRefreshResult,
  AuthStatusResult,
  AuthWhoAmIResult,
} from '../dto/auth.dto.js';

/**
 * Typed auth facade. Backed by the Codex token store (the auth SSOT) — the
 * CLI is a consumer/delegator, never an OAuth owner. The same adapter serves
 * both local and remote targets since auth concerns the local Codex token.
 */
export interface AuthFacadePort {
  status(): Promise<AuthStatusResult>;
  path(): Promise<AuthPathResult>;
  refresh(): Promise<AuthRefreshResult>;
  doctor(input: AuthDoctorInput): Promise<AuthDoctorResult>;
  login(): Promise<AuthLoginResult>;
  whoami(): Promise<AuthWhoAmIResult>;
}
