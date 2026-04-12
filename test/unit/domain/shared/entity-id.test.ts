import { describe, expect, it } from 'vitest';
import {
  createCanonicalEntityId,
  createEntityId,
  createSourceRecordId,
  isCanonicalPublicEntityId,
} from '../../../../src/domain/shared/types/entity-id.js';

describe('entity-id (ADR-007)', () => {
  it('createCanonicalEntityId rejects the forbidden public source-record namespace', () => {
    expect(() => createCanonicalEntityId('vivino-deadbeef')).toThrow(/ADR-007/);
  });

  it('createCanonicalEntityId accepts fixture-style canonical slugs', () => {
    expect(createCanonicalEntityId('opus-one-2018')).toBe('opus-one-2018');
    expect(createCanonicalEntityId('wine-ce-abc')).toBe('wine-ce-abc');
  });

  it('createEntityId mirrors canonical rules when a value is provided', () => {
    expect(() => createEntityId('vivino-x')).toThrow(/ADR-007/);
    expect(createEntityId('slug-id')).toBe('slug-id');
  });

  it('createSourceRecordId allows Vivino-style source row ids', () => {
    expect(createSourceRecordId('vivino-abc')).toBe('vivino-abc');
  });

  it('isCanonicalPublicEntityId rejects vivino- prefix', () => {
    expect(isCanonicalPublicEntityId('opus-one-2018')).toBe(true);
    expect(isCanonicalPublicEntityId('vivino-x')).toBe(false);
    expect(isCanonicalPublicEntityId('')).toBe(false);
  });
});
