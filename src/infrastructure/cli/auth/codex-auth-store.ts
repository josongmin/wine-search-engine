import { existsSync } from 'node:fs';
import {
  readCodexChatGptAuth,
  refreshCodexChatGptAuth,
  resolveCodexAuthPath,
  type CodexChatGptAuthRecord,
} from '../../ai/codex-chatgpt-auth.js';
import type { CodexAuthRecordStore } from './codex-auth-ports.js';
import { decodeCodexIdentity, type CodexIdentityClaims } from './decode-codex-identity.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Adapts the Codex auth SSOT ([[codex-chatgpt-auth]]) to the CLI's record
 * store port. Pure delegation — no second token store, no auth policy of its
 * own.
 */
export class CodexAuthStoreAdapter implements CodexAuthRecordStore {
  constructor(private readonly env: EnvLike = process.env) {}

  authPath(): string {
    return resolveCodexAuthPath(this.env);
  }

  authFileExists(): boolean {
    return existsSync(this.authPath());
  }

  read(): Promise<CodexChatGptAuthRecord | null> {
    // allowProcessFallback: the CLI is an interactive operator tool, so it
    // reads the default ~/.codex/auth.json even when CODEX_AUTH_JSON_PATH is
    // unset (the library defaults to off for embedded/server use).
    return readCodexChatGptAuth(this.env, { allowProcessFallback: true });
  }

  refresh(record: CodexChatGptAuthRecord): Promise<CodexChatGptAuthRecord> {
    return refreshCodexChatGptAuth(record, this.env);
  }

  identity(record: CodexChatGptAuthRecord): CodexIdentityClaims {
    return decodeCodexIdentity(record);
  }
}
