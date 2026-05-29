import { describe, expect, it, vi } from 'vitest';
import {
  hasLegacyEvalEntityId,
  hasLegacyEvalExpectedEntityId,
  resolveEvalEntityIds,
  resolveLegacyEvalEntityIds,
  resolveLegacyEvalExpectedEntityIds,
} from '../eval-expected-entity-id-resolution.js';

describe('eval expected entity id resolution', () => {
  it('detects generic legacy entity ids', () => {
    expect(hasLegacyEvalEntityId([
      { caseId: 'case-1', entityId: 'wine-ce-1' },
      { caseId: 'case-2', entityId: 'vivino-123' },
    ])).toBe(true);
    expect(hasLegacyEvalEntityId([
      { caseId: 'case-1', entityId: 'wine-ce-1' },
    ])).toBe(false);
  });

  it('detects legacy source-style expected ids', () => {
    expect(hasLegacyEvalExpectedEntityId([
      { caseId: 'case-1', expectedEntityId: 'wine-ce-1' },
      { caseId: 'case-2', expectedEntityId: 'vivino-123' },
    ])).toBe(true);
    expect(hasLegacyEvalExpectedEntityId([
      { caseId: 'case-1', expectedEntityId: 'wine-ce-1' },
    ])).toBe(false);
  });

  it('maps legacy source-style ids to canonical entity ids for a bound snapshot', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-a',
        },
        {
          requested_id: 'vivino-456',
          entity_id: 'wine-ce-b',
        },
      ],
    });

    const resolved = await resolveLegacyEvalExpectedEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        { caseId: 'case-1', expectedEntityId: 'vivino-123' },
        { caseId: 'case-2', expectedEntityId: 'vivino-456' },
      ],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WITH requested AS'),
      ['search-snapshot:v1:test', ['vivino-123', 'vivino-456']],
    );
    expect(resolved.get('vivino-123')).toBe('wine-ce-a');
    expect(resolved.get('vivino-456')).toBe('wine-ce-b');
  });

  it('maps generic legacy entity ids to canonical entity ids for a bound snapshot', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-a',
        },
      ],
    });

    const resolved = await resolveLegacyEvalEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        { caseId: 'case-1:relevant', entityId: 'vivino-123' },
      ],
    );

    expect(resolved.get('vivino-123')).toBe('wine-ce-a');
  });

  it('resolves runtime public ids, benchmark linkage ids, and source ids through one snapshot query', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          requested_id: 'wine-ce-runtime-a',
          entity_id: 'wine-ce-runtime-a',
        },
        {
          requested_id: 'w-opus-one-2018',
          entity_id: 'wine-ce-opus-runtime',
        },
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-opus-runtime',
        },
      ],
    });

    const resolved = await resolveEvalEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        { caseId: 'case-runtime', entityId: 'wine-ce-runtime-a' },
        { caseId: 'case-benchmark', entityId: 'w-opus-one-2018' },
        { caseId: 'case-source', entityId: 'vivino-123' },
      ],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(`e.metadata->>'benchmarkEntityId' = r.requested_id`),
      ['search-snapshot:v1:test', ['wine-ce-runtime-a', 'w-opus-one-2018', 'vivino-123']],
    );
    expect(resolved.get('wine-ce-runtime-a')).toBe('wine-ce-runtime-a');
    expect(resolved.get('w-opus-one-2018')).toBe('wine-ce-opus-runtime');
    expect(resolved.get('vivino-123')).toBe('wine-ce-opus-runtime');
  });

  it('fails closed when a legacy source id is unmapped', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-a',
        },
      ],
    });

    await expect(resolveLegacyEvalExpectedEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        { caseId: 'case-1', expectedEntityId: 'vivino-123' },
        { caseId: 'case-2', expectedEntityId: 'vivino-999' },
      ],
    )).rejects.toThrow(/Legacy eval expected_entity_id values are unmapped/);
  });

  it('fails closed when a source id maps to multiple canonical ids', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-a',
        },
        {
          requested_id: 'vivino-123',
          entity_id: 'wine-ce-b',
        },
      ],
    });

    await expect(resolveLegacyEvalExpectedEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        { caseId: 'case-1', expectedEntityId: 'vivino-123' },
      ],
    )).rejects.toThrow(/maps to multiple runtime entity ids/);
  });
});
