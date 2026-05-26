import { describe, expect, it, vi } from 'vitest';
import { PgGoldSetStore } from '../pg-gold-set-store.js';

describe('PgGoldSetStore', () => {
  it('returns canonical expected ids without legacy resolution', async () => {
    const query = vi.fn().mockResolvedValue({
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

    expect(query).toHaveBeenCalledTimes(1);
    expect(cases).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        expectedEntityId: 'wine-ce-opus',
      }),
    ]);
  });

  it('resolves legacy source-style expected ids against the bound snapshot', async () => {
    const query = vi.fn()
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
            source_record_id: 'vivino-123',
            entity_id: 'wine-ce-opus',
          },
        ],
      });

    const store = new PgGoldSetStore({ query } as never, {
      snapshotId: 'search-snapshot:v1:test',
    });

    const cases = await store.getCases();

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM entities e'),
      ['search-snapshot:v1:test', ['vivino-123']],
    );
    expect(cases).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        expectedEntityId: 'wine-ce-opus',
      }),
    ]);
  });
});
