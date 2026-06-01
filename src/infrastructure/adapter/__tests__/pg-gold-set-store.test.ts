import { describe, expect, it, vi } from 'vitest';
import { PgGoldSetStore } from '../pg-gold-set-store.js';

describe('PgGoldSetStore', () => {
  it('returns canonical expected ids without legacy resolution', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            case_id: 'case-1',
            query: 'opus one',
            query_class: 'exact_entity',
            expected_entity_id: 'wine-ce-opus',
            expected_status: 'resolved',
            label_tier: 'gold',
            annotator_agreement: 0.85,
            slice_tags: ['class:exact_entity'],
            created_at: new Date('2026-05-26T00:00:00.000Z'),
          },
        ],
      });

    const store = new PgGoldSetStore({ query } as never, {
      snapshotId: 'search-snapshot:v1:test',
    });

    const cases = await store.getCases();

    expect(query).toHaveBeenCalledTimes(2);
    expect(cases).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        expectedEntityId: 'wine-ce-opus',
      }),
    ]);
  });

  it('resolves legacy source-style expected ids against the bound snapshot', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            case_id: 'case-1',
            query: '2013 Villa Poggio Salvi Brunello di Montalcino',
            query_class: 'exact_entity',
            expected_entity_id: 'vivino-123',
            expected_status: 'resolved',
            label_tier: 'gold',
            annotator_agreement: 0.85,
            slice_tags: ['class:exact_entity'],
            created_at: new Date('2026-05-26T00:00:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            requested_id: 'vivino-123',
            entity_id: 'wine-ce-opus',
          },
        ],
      });

    const store = new PgGoldSetStore({ query } as never, {
      snapshotId: 'search-snapshot:v1:test',
    });

    const cases = await store.getCases();

    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WITH requested AS'),
      ['search-snapshot:v1:test', ['vivino-123']],
    );
    expect(cases).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        expectedEntityId: 'wine-ce-opus',
      }),
    ]);
  });

  it('uses refreshed_at for since filters when the column exists', async () => {
    const since = new Date('2026-05-27T00:00:00.000Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [] });

    const store = new PgGoldSetStore({ query } as never, {
      snapshotId: 'search-snapshot:v1:test',
    });

    await store.getCases({ since });

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('COALESCE(refreshed_at, created_at) >= $1'),
      [since],
    );
  });
});
