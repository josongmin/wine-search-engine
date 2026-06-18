import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRAFTS_DIR = path.resolve(import.meta.dirname, '../../data/lookup-v2/drafts');

describe('regression: lookup-v2 tracked draft repo purge', () => {
  it('keeps generated lookup-v2 drafts out of the repo tree', () => {
    if (!existsSync(DRAFTS_DIR)) {
      expect(existsSync(DRAFTS_DIR)).toBe(false);
      return;
    }

    expect(readdirSync(DRAFTS_DIR)).toEqual([]);
  });
});
