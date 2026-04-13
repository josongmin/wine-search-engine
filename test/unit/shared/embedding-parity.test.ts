import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '../../../src/shared/constants/embedding.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

describe('Embedding SSoT parity', () => {
  it('Vespa schema tensor dimension matches EMBEDDING_DIMENSION', () => {
    const sdPath = path.join(REPO_ROOT, 'vespa/app/schemas/wine_entity.sd');
    const sd = fs.readFileSync(sdPath, 'utf8');
    const match = sd.match(/field\s+embedding\s+type\s+tensor<float>\(x\[(\d+)]\)/);
    expect(match, 'embedding tensor declaration not found in wine_entity.sd').not.toBeNull();
    const vespaDim = Number(match![1]);
    expect(vespaDim).toBe(EMBEDDING_DIMENSION);
  });

  it('EMBEDDING_MODEL is a valid OpenAI embedding model name', () => {
    expect(EMBEDDING_MODEL).toBe('text-embedding-3-small');
  });

  it('EMBEDDING_DIMENSION is a positive integer within OpenAI supported range', () => {
    expect(Number.isInteger(EMBEDDING_DIMENSION)).toBe(true);
    expect(EMBEDDING_DIMENSION).toBeGreaterThan(0);
    expect(EMBEDDING_DIMENSION).toBeLessThanOrEqual(3072);
  });
});
