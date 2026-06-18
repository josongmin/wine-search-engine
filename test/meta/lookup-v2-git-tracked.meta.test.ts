/**
 * Meta gate: ELV2/curation critical artifacts must be git-tracked (staged or committed).
 * Prevents partial merges where production imports exist only as local untracked files.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

const LOOKUP_V2_TRACKED_ARTIFACTS = [
  'src/domain/resolver/v2/lookup-v2-substrate-capabilities.ts',
  'src/application/search/entity-lookup-v2/entity-lookup-v2-candidate-projection.ts',
  'src/domain/resolver/model/fuzzy-match-confidence.ts',
  'src/domain/alias/model/ops-curated-alias-types.ts',
  'web/src/shared/constants/ops-curated-alias-types.ts',
  'src/domain/alias/service/alias-phonetic-keys.ts',
  'src/infrastructure/db/migrations/034_aliases_phonetic_keys.sql',
  'test/meta/lookup-v2-runtime-registry-context.meta.test.ts',
  'test/meta/lookup-v2-active-pointer-proof.meta.test.ts',
  'test/meta/lookup-v2-critical-artifacts.meta.test.ts',
  'test/regression/lookup-v2-silent-skip-kinds.regression.test.ts',
  'test/regression/lookup-v2-ops-curated-alias-types.regression.test.ts',
] as const;

function isGitTracked(relativePath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- "${relativePath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

describe('lookup-v2 critical artifacts git-tracked (meta)', () => {
  for (const relativePath of LOOKUP_V2_TRACKED_ARTIFACTS) {
    it(`is tracked by git: ${relativePath}`, () => {
      const absolutePath = path.join(REPO_ROOT, relativePath);
      expect(isGitTracked(relativePath), `${relativePath} must be git add-ed before push`).toBe(true);
      expect(() => execSync(`test -f "${absolutePath}"`, { cwd: REPO_ROOT })).not.toThrow();
    });
  }
});
