import { describe, expect, it } from 'vitest';
import {
  SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN,
  SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX,
  isSourceRecordStylePublicEntityId,
} from '../../../src/shared/constants/public-entity-id-namespace.js';

describe('public-entity-id-namespace (ADR-007)', () => {
  it('defines a Postgres LIKE pattern consistent with the source-record prefix', () => {
    expect(SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX).toBe('vivino-');
    expect(SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN).toBe('vivino-%');
  });

  it('detects source-style ids that must not appear as public entity_id', () => {
    expect(isSourceRecordStylePublicEntityId('vivino-abc')).toBe(true);
    expect(isSourceRecordStylePublicEntityId('opus-one-2018')).toBe(false);
    expect(isSourceRecordStylePublicEntityId('wine-ce-deadbeef')).toBe(false);
  });
});
