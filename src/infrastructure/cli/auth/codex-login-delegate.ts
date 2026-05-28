import type { AuthLoginResult } from '../../../application/cli/dto/auth.dto.js';
import type { CodexLoginDelegate } from './codex-auth-ports.js';

const CODEX_LOGIN_COMMAND = 'codex login';

/**
 * Login is delegated to Codex, not owned by this CLI (architecture decision
 * §8). The delegate returns an explicit contract pointing operators at
 * `codex login` rather than implementing an OAuth browser/device flow here.
 */
export class CodexLoginDelegateAdapter implements CodexLoginDelegate {
  describe(alreadyAuthenticated: boolean): AuthLoginResult {
    const message = alreadyAuthenticated
      ? `Already authenticated via Codex. To re-authenticate, run \`${CODEX_LOGIN_COMMAND}\`.`
      : `Login is owned by Codex. Run \`${CODEX_LOGIN_COMMAND}\` to authenticate, then retry.`;
    return {
      delegated: false,
      supported: true,
      alreadyAuthenticated,
      delegateCommand: CODEX_LOGIN_COMMAND,
      message,
    };
  }
}
