import { describe, expect, it } from 'vitest';

import { TEST_ALIASES, TEST_DOCUMENTS } from './test-fixtures.js';

function hasHangul(value: string): boolean {
  return /[\u3131-\u318E\uAC00-\uD7A3]/u.test(value);
}

describe('test fixture alias authority', () => {
  it('keeps high-confidence Korean exact aliases in identity-safe projection', () => {
    const docsById = new Map(TEST_DOCUMENTS.map((doc) => [String(doc.entityId), doc] as const));

    for (const alias of TEST_ALIASES) {
      if (alias.confidence < 0.9 || !hasHangul(alias.surfaceForm)) {
        continue;
      }

      const doc = docsById.get(String(alias.entityId));
      expect(doc, `missing fixture document for ${String(alias.entityId)}`).toBeDefined();
      expect(
        doc?.aliasesIdentitySafe,
        `high-confidence Korean alias "${alias.surfaceForm}" must stay identity-safe for ${String(alias.entityId)}`,
      ).toContain(alias.surfaceForm);
    }
  });
});
