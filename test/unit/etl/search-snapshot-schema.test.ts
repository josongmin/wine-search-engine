import { describe, expect, it } from 'vitest';
import {
  buildSearchSnapshotId,
  hashStableJson,
  stableJsonStringify,
} from '../../../scripts/etl/search-snapshot-schema.js';

describe('search-snapshot-schema helpers', () => {
  it('stableJsonStringify is insensitive to object key order', () => {
    const left = {
      b: 2,
      a: {
        z: 1,
        y: [3, 2, 1],
      },
    };
    const right = {
      a: {
        y: [3, 2, 1],
        z: 1,
      },
      b: 2,
    };

    expect(stableJsonStringify(left)).toBe(stableJsonStringify(right));
    expect(hashStableJson(left)).toBe(hashStableJson(right));
  });

  it('builds deterministic snapshot ids from a content hash prefix', () => {
    expect(buildSearchSnapshotId('0123456789abcdef0123456789abcdef')).toBe(
      'search-snapshot:v1:0123456789abcdef',
    );
  });
});
