import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { OpsCoverageView } from '../coverage-view';
import { api } from '@/shared/api/client';

vi.mock('@/shared/api/client', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      ops: {
        coverageHealth: vi.fn(),
        aliasAudit: vi.fn(),
      },
    },
  };
});

const ops = vi.mocked(api.ops);
const DEBUG_KEY = 'debug-secret-key';

describe('OpsCoverageView', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY);
    ops.coverageHealth.mockReset();
    ops.aliasAudit.mockReset();
  });

  it('shows published_awaiting_materialization backlog from coverage-health', async () => {
    ops.coverageHealth.mockResolvedValue({
      queue_by_status: { pending: 1, approved: 0, rejected: 0, published: 2 },
      queue_by_kind: { alias: 3, ambiguity: 0, suppression: 0 },
      total_proposals: 3,
      published_awaiting_materialization: 2,
      legacy_approved_abbreviation_backlog: 1,
      lookup_runtime: {
        search_snapshot_id: 'search-snapshot:v1:test',
        family_graph_edge_count: 4,
        ltr_support_status: 'unsupported',
        ltr_support_reason: 'lookup_domain_model_absent',
        unwired_substrate_ids: ['lookup_ltr_rerank'],
      },
    });

    renderWithProviders(<OpsCoverageView />);

    await waitFor(() => {
      expect(screen.getByText('awaiting materialization')).toBeInTheDocument();
    });
    const backlogRow = screen.getByText('awaiting materialization').closest('div');
    expect(backlogRow).not.toBeNull();
    expect(backlogRow?.textContent).toContain('2');
    expect(screen.getByText('legacy approved abbreviation')).toBeInTheDocument();
    expect(screen.getByText('family graph edges: 4')).toBeInTheDocument();
    expect(screen.getByText('unwired: lookup_ltr_rerank')).toBeInTheDocument();
    expect(ops.coverageHealth).toHaveBeenCalledWith(DEBUG_KEY);
  });
});
