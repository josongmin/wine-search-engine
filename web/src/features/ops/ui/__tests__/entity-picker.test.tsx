import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { EntityPicker } from '../entity-picker';
import { api } from '@/shared/api/client';
import type { OpsInspectResponse } from '@/shared/api/ops-types';

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
  return { ApiError, api: { ops: { inspect: vi.fn() } } };
});

const inspectMock = vi.mocked(api.ops.inspect);

function inspectResult(): OpsInspectResponse {
  return {
    status: 'ambiguous',
    decision_reason: 'Calibration untrusted',
    candidates: [
      { entity_id: 'sassicaia-2018', canonical_label: 'Sassicaia 2018', calibrated_score: 1, rank: 1 },
      { entity_id: 'sassicaia-2019', canonical_label: 'Sassicaia 2019', calibrated_score: 0.9, rank: 2 },
    ],
    top_candidate: null,
    evidence_summary: {
      admission_reason_code: 'x',
      decision_reason_code: 'y',
      calibration_trusted: false,
      query_class: 'identity',
      candidate_pool_size: 2,
      channel_coverage: [],
    },
  };
}

describe('EntityPicker', () => {
  beforeEach(() => {
    inspectMock.mockReset();
  });

  it('searches via ops.inspect and renders candidates', async () => {
    inspectMock.mockResolvedValue(inspectResult());
    renderWithProviders(<EntityPicker debugKey="secret-key" onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    await waitFor(() => expect(screen.getByText('Sassicaia 2018')).toBeInTheDocument());
    expect(screen.getByText('Sassicaia 2019')).toBeInTheDocument();
    expect(inspectMock).toHaveBeenCalledWith('sassicaia', 'secret-key');
  });

  it('emits the picked candidate (entity_id + label + score) on click', async () => {
    inspectMock.mockResolvedValue(inspectResult());
    const onSelect = vi.fn();
    renderWithProviders(<EntityPicker debugKey="secret-key" onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByText('Sassicaia 2018')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Sassicaia 2018'));
    expect(onSelect).toHaveBeenCalledWith({
      entity_id: 'sassicaia-2018',
      canonical_label: 'Sassicaia 2018',
      calibrated_score: 1,
    });
  });

  it('does not call the API and shows a hint when the debug key is empty', () => {
    renderWithProviders(<EntityPicker debugKey="" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: 'sassicaia' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    expect(inspectMock).not.toHaveBeenCalled();
    expect(screen.getByText(/enter the x-debug-key/i)).toBeInTheDocument();
  });

  it('ignores a blank/whitespace query', () => {
    inspectMock.mockResolvedValue(inspectResult());
    renderWithProviders(<EntityPicker debugKey="secret-key" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it('renders an empty-candidate message without throwing', async () => {
    inspectMock.mockResolvedValue({ ...inspectResult(), candidates: [] });
    renderWithProviders(<EntityPicker debugKey="secret-key" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('entity search query'), { target: { value: '없는와인' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByText('No candidates.')).toBeInTheDocument());
  });
});
