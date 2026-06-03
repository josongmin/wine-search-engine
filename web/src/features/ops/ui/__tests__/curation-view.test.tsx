import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { OpsCurationView } from '../curation-view';
import { api } from '@/shared/api/client';
import type {
  AliasAuditResponse,
  ListProposalsResponse,
  OpsInspectResponse,
} from '@/shared/api/ops-types';

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
        inspect: vi.fn(),
        aliasAudit: vi.fn(),
        listProposals: vi.fn(),
        submitProposal: vi.fn(),
        reviewProposal: vi.fn(),
        publishProposal: vi.fn(),
        coverageHealth: vi.fn(),
      },
    },
  };
});

const ops = vi.mocked(api.ops);

const DEBUG_KEY = 'debug-secret-key';
const WRITE_KEY = 'write-secret-key';

function seedKeys() {
  sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY);
  sessionStorage.setItem('elv2.ops.writeKey', WRITE_KEY);
}

function emptyAudit(entityId: string): AliasAuditResponse {
  return { entity_id: entityId, aliases: [], related_proposals: [] };
}

function inspectResult(): OpsInspectResponse {
  return {
    status: 'ambiguous',
    decision_reason: 'reason',
    candidates: [
      { entity_id: 'sassicaia-2018', canonical_label: 'Sassicaia 2018', calibrated_score: 1, rank: 1 },
    ],
    top_candidate: null,
    evidence_summary: {
      admission_reason_code: 'x',
      decision_reason_code: 'y',
      calibration_trusted: false,
      query_class: 'identity',
      candidate_pool_size: 1,
      channel_coverage: [],
    },
  };
}

const noProposals: ListProposalsResponse = { proposals: [] };

describe('OpsCurationView', () => {
  beforeEach(() => {
    sessionStorage.clear();
    Object.values(ops).forEach((fn) => fn.mockReset());
    ops.listProposals.mockResolvedValue(noProposals);
    ops.inspect.mockResolvedValue(inspectResult());
    ops.aliasAudit.mockImplementation((id: string) => Promise.resolve(emptyAudit(id)));
    ops.submitProposal.mockResolvedValue({ proposal: {} as never });
    ops.reviewProposal.mockResolvedValue({ proposal: {} as never });
  });

  it('renders the workbench, queue, and advanced sections', () => {
    renderWithProviders(<OpsCurationView />);
    expect(screen.getByText('Keyword workbench')).toBeInTheDocument();
    expect(screen.getByText('Proposal queue')).toBeInTheDocument();
    expect(screen.getByText('Advanced proposals')).toBeInTheDocument();
  });

  it('runs the full pick-entity → add-keyword flow with the alias payload', async () => {
    seedKeys();
    renderWithProviders(<OpsCurationView />);

    // 1. search and pick the wine (no slug typed by hand)
    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByText('Sassicaia 2018')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Sassicaia 2018'));

    // 2. audit loads for the picked entity
    await waitFor(() => expect(ops.aliasAudit).toHaveBeenCalledWith('sassicaia-2018', DEBUG_KEY));
    expect(screen.getByText('No live keywords yet.')).toBeInTheDocument();

    // 3. add a keyword bound to that entity
    fireEvent.change(screen.getByLabelText('surface form'), { target: { value: '사씨카이아' } });
    fireEvent.change(screen.getByLabelText('alias type'), { target: { value: 'phonetic' } });
    fireEvent.change(screen.getByLabelText('confidence'), { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(ops.submitProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'alias',
          surface_form: '사씨카이아',
          target_entity_id: 'sassicaia-2018',
          proposed_type: 'phonetic',
          confidence: 0.9,
        }),
        WRITE_KEY,
      ),
    );
  });

  it('blocks add when the write key is missing', async () => {
    sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY); // read only, no write key
    renderWithProviders(<OpsCurationView />);

    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByText('Sassicaia 2018')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Sassicaia 2018'));
    await waitFor(() => expect(ops.aliasAudit).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('surface form'), { target: { value: 'sass' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(screen.getByText(/x-ops-write-key required for writes/i)).toBeInTheDocument(),
    );
    expect(ops.submitProposal).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range confidence before calling the API', async () => {
    seedKeys();
    renderWithProviders(<OpsCurationView />);
    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByText('Sassicaia 2018')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Sassicaia 2018'));
    await waitFor(() => expect(ops.aliasAudit).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('surface form'), { target: { value: 'sass' } });
    fireEvent.change(screen.getByLabelText('confidence'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByText(/between 0 and 1/i)).toBeInTheDocument());
    expect(ops.submitProposal).not.toHaveBeenCalled();
  });

  it('approves a pending proposal with the review payload', async () => {
    seedKeys();
    ops.listProposals.mockResolvedValue({
      proposals: [
        {
          proposal_id: 'p1',
          kind: 'alias',
          status: 'pending',
          evidence: {},
          created_at: 't',
          updated_at: 't',
          surface_form: 'sass',
          target_entity_id: 'sassicaia-2018',
          proposed_type: 'misspelling',
          confidence: 0.8,
        },
      ],
    });
    renderWithProviders(<OpsCurationView />);

    await waitFor(() => expect(screen.getByText(/sass → sassicaia-2018/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() =>
      expect(ops.reviewProposal).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'alias', proposal_id: 'p1', decision: 'approve' }),
        WRITE_KEY,
      ),
    );
  });

  it('passes status/kind filters to listProposals', async () => {
    seedKeys();
    renderWithProviders(<OpsCurationView />);
    await waitFor(() => expect(ops.listProposals).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('filter by status'), { target: { value: 'approved' } });
    await waitFor(() =>
      expect(ops.listProposals).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
        DEBUG_KEY,
      ),
    );
  });
});
