import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Foundation wire-up smoke tests.
 *
 * These tests pin the production wire-ups of foundation modules that were
 * previously test-only:
 *   - `per-class-fusion-config.ts` → `candidate-pool.ts` (Epic-16 / T16-2)
 *   - `query-difficulty-estimator.ts` → `candidate-pool.ts` (Epic-16 / T16-4,
 *     parallel / observability-only wire)
 *   - `stage-timer.ts` → `hybrid.usecase.ts` (already wired pre-session)
 *
 * The assertions scan source text rather than executing the full retrieval
 * pipeline — exercising CandidatePoolService end-to-end requires heavy
 * mocking of ports that is well-covered by the existing
 * `candidate-pool-*.test.ts` suite. This file's job is exclusively to
 * guard against a silent regression where the foundation import is
 * removed and the module reverts to dead code.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = join(__dirname, '..');
const HYBRID_USECASE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'application',
  'search',
  'hybrid.usecase.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('foundation wire-up (candidate-pool)', () => {
  const source = read(join(SERVICE_DIR, 'candidate-pool.ts'));

  it('imports getFusionConfig from per-class-fusion-config', () => {
    expect(source).toMatch(/from '\.\/per-class-fusion-config\.js'/);
    expect(source).toMatch(/getFusionConfig/);
  });

  it('calls getFusionConfig and uses its rrfK for the fuse step', () => {
    // Must reference the per-class mapping function we introduced.
    expect(source).toMatch(/mapToFusionQueryClass\(/);
    // Must derive an effective fusion K from the per-class config …
    expect(source).toMatch(/effectiveFusionK\s*=\s*fusionConfig\.rrfK/);
    // … and pass it to the RRF fuse call (not the old profile.fusionK).
    expect(source).toMatch(/fusionService\.fuse\([\s\S]*?effectiveFusionK/);
  });

  it('maps RFC-005 short_entity onto specific_wine fusion class', () => {
    expect(source).toMatch(
      /case 'short_entity':[\s\S]*?return 'specific_wine'/,
    );
  });

  it('imports and invokes estimateQueryDifficulty in parallel with the cascade router', () => {
    expect(source).toMatch(
      /from '\.\/query-difficulty-estimator\.js'/,
    );
    expect(source).toMatch(/estimateQueryDifficulty\(/);
    // The parallel wire must emit an agreement log so sweeps can quantify
    // drift before a full replacement.
    expect(source).toMatch(/retrieval\.difficulty_parallel/);
  });
});

describe('foundation wire-up (hybrid.usecase stage-timer)', () => {
  const source = read(HYBRID_USECASE);

  it('creates a stage timer and snapshots it at the end of the request', () => {
    expect(source).toMatch(/createStageTimer/);
    expect(source).toMatch(/stageTimer\.start\('hybrid\.total'\)/);
    expect(source).toMatch(/stageTimer\.end\('hybrid\.total'\)/);
    expect(source).toMatch(/stageTimer\.snapshot\(\)/);
  });
});

describe('foundation wire-up (per-class-fusion-config behavior preservation)', () => {
  it('DEFAULT_FUSION_CONFIG.rrfK matches the profile-default k=60 so unknown/fallback classes are behavior-preserving', async () => {
    const mod = await import('../per-class-fusion-config.js');
    expect(mod.DEFAULT_FUSION_CONFIG.rrfK).toBe(60);
    expect(mod.getFusionConfig('fallback').rrfK).toBe(60);
    // Specific-wine should deliberately differ — proving the wire-up is
    // not a no-op for mapped classes.
    expect(mod.getFusionConfig('specific_wine').rrfK).not.toBe(60);
  });
});
