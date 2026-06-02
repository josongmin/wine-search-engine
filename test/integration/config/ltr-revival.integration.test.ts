import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRuntimeSupportServices } from '../../../src/config/container-runtime-support.js';
import { parseEnv } from '../../../src/config/env.js';
import {
  LAMBDAMART_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
} from '../../../src/domain/ranking/service/lambdamart-ranker.js';

/**
 * T-ELV2-05: serving-ON wiring through the PG-less runtime-artifact path.
 * Proves the kill-switch fix actually threads a loaded model to
 * RuntimeSupportServices.ltrModels + the readiness `effective` snapshot — the
 * behaviour the old hardcoded `return false` / `ltrModels: undefined` blocked.
 * (Registry/PG path is infra-gated; the artifact path needs no PG.)
 *
 * This exercises the WIRING with a structurally-valid model only — it does NOT
 * assert the OOD train-serve projection is valid (that remains blocked).
 */
function validArtifactEntry(queryClass: string) {
  return {
    queryClass,
    weights: Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 0.1),
    bias: 0,
    featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
    trainingExampleCount: 100,
    ndcg5ValidationScore: 0.8,
    trainedAt: '2026-06-02T00:00:00.000Z',
  };
}

describe('LTR revival — serving-ON via runtime artifact (PG-less)', () => {
  let dir: string;
  let goodPath: string;
  let badPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ltr-revival-'));
    goodPath = path.join(dir, 'good.json');
    badPath = path.join(dir, 'bad.json');
    await writeFile(goodPath, JSON.stringify({ models: [validArtifactEntry('known-item')] }), 'utf8');
    // Wrong feature schema hash → loader rejects the entry (returns undefined per-entry).
    await writeFile(
      badPath,
      JSON.stringify({ models: [{ ...validArtifactEntry('known-item'), featureSchemaHash: 'WRONG_HASH' }] }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serving=true + valid artifact ⇒ ltrModels loaded, effective.source=runtime_artifact', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'true', RUNTIME_LTR_MODELS_PATH: goodPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeDefined();
    expect(services.ltrModels?.size).toBe(1);
    const eff = services.runtimeReadiness.ltrModels.effective;
    expect(eff.source).toBe('runtime_artifact');
    expect(eff.loaded).toBe(true);
    expect(services.runtimeReadiness.ltrModels.artifact.selected).toBe(true);
  });

  it('serving=FALSE + valid artifact ⇒ ltrModels undefined, effective disabled (gate wins)', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'false', RUNTIME_LTR_MODELS_PATH: goodPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.effective.source).toBe('none');
    expect(services.runtimeReadiness.ltrModels.effective.issue).toBe('disabled');
  });

  it('serving=true + schema-mismatch artifact ⇒ ltrModels undefined via none path (no throw)', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'true', RUNTIME_LTR_MODELS_PATH: badPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.effective.source).toBe('none');
    expect(services.runtimeReadiness.ltrModels.effective.loaded).toBe(false);
  });
});
