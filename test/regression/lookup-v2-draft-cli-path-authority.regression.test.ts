import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const DRAFT_PATH_AUTHORITY_SCRIPTS = [
  'scripts/eval/approve-lookup-v2-reviewed-authority-exact-safe-proposal-packet.ts',
  'scripts/eval/apply-lookup-v2-exact-safe-family-review-packet.ts',
  'scripts/eval/apply-lookup-v2-exact-safe-proposal-packet.ts',
  'scripts/eval/apply-lookup-v2-manual-target-family-review-packet.ts',
  'scripts/eval/apply-lookup-v2-policy-family-review-packet.ts',
  'scripts/eval/build-lookup-v2-stretch-expansion-prompt.ts',
  'scripts/eval/export-lookup-v2-catalog-absent-family-clusters.ts',
  'scripts/eval/export-lookup-v2-curation-drafts.ts',
  'scripts/eval/export-lookup-v2-exact-safe-family-review-packet.ts',
  'scripts/eval/export-lookup-v2-exact-safe-family-suggestions.ts',
  'scripts/eval/export-lookup-v2-exact-safe-proposal-packet.ts',
  'scripts/eval/export-lookup-v2-manual-target-batches.ts',
  'scripts/eval/export-lookup-v2-manual-target-family-review-packet.ts',
  'scripts/eval/export-lookup-v2-manual-target-family-suggestions.ts',
  'scripts/eval/export-lookup-v2-manual-target-owner-family-clusters.ts',
  'scripts/eval/export-lookup-v2-manual-target-runtime-owner-partitions.ts',
  'scripts/eval/export-lookup-v2-policy-family-review-packet.ts',
  'scripts/eval/export-lookup-v2-policy-family-suggestions.ts',
  'scripts/eval/export-lookup-v2-policy-review-packet.ts',
  'scripts/eval/export-lookup-v2-reviewed-collision-family-clusters.ts',
  'scripts/eval/export-lookup-v2-reviewed-collision-family-review-packet.ts',
  'scripts/eval/export-lookup-v2-scope-support-family-clusters.ts',
  'scripts/eval/refresh-lookup-v2-stretch-write-plane.ts',
  'scripts/eval/review-lookup-v2-exact-safe-family-review-packet.ts',
  'scripts/eval/review-lookup-v2-exact-safe-proposal-packet.ts',
  'scripts/eval/review-lookup-v2-manual-target-family-review-packet.ts',
  'scripts/eval/review-lookup-v2-policy-family-review-packet.ts',
  'scripts/eval/review-lookup-v2-policy-review-packet.ts',
] as const;

describe('regression: lookup-v2 draft CLI path authority', () => {
  it('routes tracked draft path defaults through resolveCliDataPathArg', () => {
    for (const relativePath of DRAFT_PATH_AUTHORITY_SCRIPTS) {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      expect(source, `${relativePath} should import the shared lookup-v2 draft path helper`).toContain(
        "import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';",
      );
      expect(source, `${relativePath} should route repo-relative draft paths through the helper`).toContain(
        'resolveCliDataPathArg(',
      );
      expect(source, `${relativePath} should build lookup-v2 draft defaults via the shared helper`).toContain(
        'lookupV2DraftCliPath(',
      );
      expect(source, `${relativePath} should not embed repo-tracked draft literals directly`).not.toContain(
        'data/lookup-v2/drafts',
      );
    }
  });
});
