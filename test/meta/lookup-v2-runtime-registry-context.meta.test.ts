/**
 * Meta gate: runtime-bound lookup-v2 CLIs share the registry context helper.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RUNTIME_BOUND_LOOKUP_V2_SCRIPTS = [
  'scripts/eval/export-lookup-v2-curation-drafts.ts',
  'scripts/eval/export-lookup-v2-exact-safe-proposal-packet.ts',
  'scripts/eval/refresh-lookup-v2-stretch-write-plane.ts',
  'scripts/eval/verify-lookup-v2-stretch-reviewed-registry-overlay.ts',
  'scripts/eval/sync-lookup-v2-localized-scope-surface-registry-from-draft.ts',
  'scripts/eval/apply-lookup-v2-policy-family-review-packet.ts',
  'scripts/eval/apply-lookup-v2-policy-review-packet.ts',
] as const;

describe('lookup-v2 runtime registry context contracts (meta)', () => {
  it('routes tracked runtime-bound CLIs through the shared runtime registry context', () => {
    for (const relativePath of RUNTIME_BOUND_LOOKUP_V2_SCRIPTS) {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      expect(source, `${relativePath} should import the shared runtime registry context helper`).toContain(
        'loadLookupV2RuntimeRegistryContextSync',
      );
      expect(source, `${relativePath} should expose runtimeState on the CLI surface`).toContain(
        "runtimeState: { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH }",
      );
      expect(source, `${relativePath} should build loader inputs from the shared runtime registry context`).toContain(
        'loadLookupV2RuntimeRegistryContextSync(runtimeStatePath)',
      );
    }
  });
});
