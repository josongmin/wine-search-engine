import { describe, expect, it } from 'vitest';
import {
  buildParityReport,
  type ParityRow,
} from '../../../scripts/eval/lookup-v2-parity-metrics.js';

const OPUS = 'opus-one-2018';

describe('buildParityReport', () => {
  it('passes when direct authority and full container produce identical outcomes', () => {
    const rows: ParityRow[] = [
      {
        qid: 'q1',
        query: 'Opus One 2018',
        expectedStatus: 'resolved',
        expectedEntityId: OPUS,
        direct: { status: 'resolved', topEntityId: OPUS, topLabel: 'Opus One 2018' },
        fullContainer: { status: 'resolved', topEntityId: OPUS, topLabel: 'Opus One 2018' },
      },
      {
        qid: 'q2',
        query: '까쇼',
        expectedStatus: 'redirect_discovery',
        direct: { status: 'redirect_discovery' },
        fullContainer: { status: 'redirect_discovery' },
      },
    ];

    const report = buildParityReport(rows);
    expect(report.gate.pass).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.direct.correct).toBe(2);
    expect(report.fullContainer.correct).toBe(2);
  });

  it('fails when the full container diverges in status', () => {
    const rows: ParityRow[] = [
      {
        qid: 'q1',
        query: 'Opus One',
        expectedStatus: 'resolved',
        expectedEntityId: OPUS,
        direct: { status: 'resolved', topEntityId: OPUS, topLabel: 'Opus One 2018' },
        fullContainer: { status: 'ambiguous' },
      },
    ];

    const report = buildParityReport(rows);
    expect(report.gate.pass).toBe(false);
    expect(report.divergences[0]).toMatchObject({ mismatch: 'status', qid: 'q1' });
  });

  it('fails when both sides resolve but to different entities', () => {
    const rows: ParityRow[] = [
      {
        qid: 'q1',
        query: 'Opus One',
        expectedStatus: 'resolved',
        expectedEntityId: OPUS,
        direct: { status: 'resolved', topEntityId: OPUS, topLabel: 'Opus One 2018' },
        fullContainer: { status: 'resolved', topEntityId: 'opus-one-2019', topLabel: 'Opus One 2019' },
      },
    ];

    const report = buildParityReport(rows);
    expect(report.gate.pass).toBe(false);
    expect(report.divergences[0]).toMatchObject({ mismatch: 'resolved_entity', qid: 'q1' });
  });
});
