/**
 * Meta gate: ELV2/curation production artifacts must exist on disk.
 * Prevents partial merges where wired imports reference missing files.
 */
import { accessSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

const LOOKUP_V2_CRITICAL_ARTIFACTS = [
  'src/domain/resolver/v2/lookup-v2-substrate-capabilities.ts',
  'src/domain/resolver/v2/__tests__/lookup-v2-substrate-capabilities.test.ts',
  'src/application/search/entity-lookup-v2/entity-lookup-v2-candidate-projection.ts',
  'src/application/search/entity-lookup-v2/__tests__/entity-lookup-v2-candidate-projection.test.ts',
  'src/domain/resolver/model/fuzzy-match-confidence.ts',
  'src/domain/alias/model/ops-curated-alias-types.ts',
  'web/src/shared/constants/ops-curated-alias-types.ts',
  'src/domain/alias/service/alias-phonetic-keys.ts',
  'src/domain/alias/service/__tests__/alias-phonetic-keys.test.ts',
  'scripts/etl/load-published-curation-proposals.ts',
  'src/infrastructure/db/migrations/033_lookup_v2_curation_materialization.sql',
  'src/infrastructure/db/migrations/rollback/033_lookup_v2_curation_materialization_rollback.sql',
  'src/infrastructure/db/migrations/034_aliases_phonetic_keys.sql',
  'src/infrastructure/db/migrations/rollback/034_aliases_phonetic_keys_rollback.sql',
  'test/meta/lookup-v2-runtime-registry-context.meta.test.ts',
  'test/meta/lookup-v2-active-pointer-proof.meta.test.ts',
  'test/meta/fuzzy-match-confidence-ssot.test.ts',
  'test/meta/lookup-v2-critical-artifacts.meta.test.ts',
  'test/meta/meta-config-exhaustiveness.meta.test.ts',
  'test/meta/ci-verification-core-parity.meta.test.ts',
  'test/meta/lookup-v2-git-tracked.meta.test.ts',
  'test/unit/meta/bench-smoke-lookup-v2-contract.meta.test.ts',
  'test/unit/meta/curation-integration-lane-parity.test.ts',
  'test/unit/meta/smart-lane-noisy-gate-parity.test.ts',
  'test/regression/lookup-v2-silent-skip-kinds.regression.test.ts',
  'test/regression/lookup-v2-ops-curated-alias-types.regression.test.ts',
  'test/regression/lookup-v2-operator-bucket-ssot.regression.test.ts',
  'test/regression/lookup-v2-p0-policy-collision-stretch.regression.test.ts',
] as const;

describe('lookup-v2 critical artifacts (meta)', () => {
  for (const relativePath of LOOKUP_V2_CRITICAL_ARTIFACTS) {
    it(`exists: ${relativePath}`, () => {
      const absolutePath = path.join(REPO_ROOT, relativePath);
      expect(() => accessSync(absolutePath)).not.toThrow();
    });
  }
});
