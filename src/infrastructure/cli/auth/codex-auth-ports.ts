import type { CodexChatGptAuthRecord } from '../../ai/codex-chatgpt-auth.js';
import type { CodexModelCatalogProbeResult } from '../../ai/codex-model-catalog.js';
import type { CodexIdentityClaims } from './decode-codex-identity.js';
import type { AuthLoginResult } from '../../../application/cli/dto/auth.dto.js';

/**
 * Infra-internal collaborator ports for the Codex-backed auth facade. They
 * exist so {@link CodexAuthFacade} is unit-testable with fakes — no real file
 * reads or network calls in tests — while production wiring uses the real
 * Codex adapters.
 */
export interface CodexAuthRecordStore {
  authPath(): string;
  authFileExists(): boolean;
  read(): Promise<CodexChatGptAuthRecord | null>;
  refresh(record: CodexChatGptAuthRecord): Promise<CodexChatGptAuthRecord>;
  identity(record: CodexChatGptAuthRecord): CodexIdentityClaims;
}

export interface CodexModelCatalogProbe {
  probe(record: CodexChatGptAuthRecord): Promise<CodexModelCatalogProbeResult>;
}

export interface CodexLoginDelegate {
  describe(alreadyAuthenticated: boolean): AuthLoginResult;
}
