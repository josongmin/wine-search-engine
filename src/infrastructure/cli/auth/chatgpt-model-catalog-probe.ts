import {
  probeCodexModelCatalog,
  type CodexModelCatalogProbeResult,
} from '../../ai/codex-model-catalog.js';
import type { CodexChatGptAuthRecord } from '../../ai/codex-chatgpt-auth.js';
import type { CodexModelCatalogProbe } from './codex-auth-ports.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * CLI doctor probe of `/codex/models`, delegating to the shared SSoT probe
 * ([[codex-model-catalog]]) so the request shape never drifts from the
 * production chat adapter.
 */
export class ChatGptModelCatalogProbeAdapter implements CodexModelCatalogProbe {
  constructor(private readonly env: EnvLike = process.env) {}

  probe(record: CodexChatGptAuthRecord): Promise<CodexModelCatalogProbeResult> {
    return probeCodexModelCatalog(record, { env: this.env });
  }
}
