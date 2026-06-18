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
 * Legacy LTR env may still be present, but serving remains structurally
 * unsupported until a lookup-domain model exists. Pin the fail-closed
 * contract for both serving=true and serving=false configurations.
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

describe('LTR remains unsupported in shared runtime support', () => {
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

  it('serving=true + valid artifact still stays unsupported', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'true', RUNTIME_LTR_MODELS_PATH: goodPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeUndefined();
    const eff = services.runtimeReadiness.ltrModels.effective;
    expect(eff.source).toBe('none');
    expect(eff.loaded).toBe(false);
    expect(eff.issue).toBe('unsupported');
    expect(services.runtimeReadiness.ltrModels.artifact.selected).toBe(false);
  });

  it('serving=false + valid artifact still reports unsupported', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'false', RUNTIME_LTR_MODELS_PATH: goodPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.effective.source).toBe('none');
    expect(services.runtimeReadiness.ltrModels.effective.issue).toBe('unsupported');
  });

  it('serving=true + schema-mismatch artifact stays unsupported without throw', async () => {
    const config = parseEnv({ NODE_ENV: 'test', LTR_SERVING_ENABLED: 'true', RUNTIME_LTR_MODELS_PATH: badPath });
    const services = await buildRuntimeSupportServices(config, {});
    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.effective.source).toBe('none');
    expect(services.runtimeReadiness.ltrModels.effective.loaded).toBe(false);
    expect(services.runtimeReadiness.ltrModels.effective.issue).toBe('unsupported');
  });
});
