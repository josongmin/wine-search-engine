import { describe, expect, it } from 'vitest';

import {
  analyzeRow,
  buildReport,
  type BootstrapClaimRow,
} from '../../../scripts/eval/analyze-legacy-claim-bootstrap.ts';

describe('legacy claim bootstrap analysis', () => {
  it('maps historical semantic/comparative misses onto current legacy surfaces', () => {
    const rows: readonly BootstrapClaimRow[] = [
      {
        claimId: 'bootstrap-008',
        claim: {
          id: 'c-sassicaia-pairing',
          type: 'pairing_assertion',
          category: 'semantic_claim',
          text: 'Sassicaia pairs well with grilled ribeye steak',
          entityId: 'sassicaia-2018',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.5,
        shadowAnswerText: 'Sassicaia 2018 pairs well with grilled ribeye and hearty red meat dishes.',
      },
      {
        claimId: 'bootstrap-012',
        claim: {
          id: 'c-grange-compare',
          type: 'comparative_assertion',
          category: 'comparative_claim',
          text: 'Penfolds Grange is more powerful than a traditional Barolo',
          entityId: 'penfolds-grange-2017',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.5,
        shadowAnswerText: 'Penfolds Grange is more powerful and concentrated than a traditional Barolo.',
      },
      {
        claimId: 'bootstrap-015',
        claim: {
          id: 'c-masi-rec',
          type: 'recommendation',
          category: 'semantic_claim',
          text: 'recommended for a cold winter evening',
          entityId: 'masi-amarone',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.3,
        shadowAnswerText: 'Masi Amarone is recommended for a cold winter evening near the fireplace.',
      },
    ];

    const analyzed = rows.map(analyzeRow);
    expect(analyzed.every((row) => row.matched)).toBe(true);
    expect(analyzed.find((row) => row.bootstrapType === 'pairing_assertion')?.matchedByField).toBe(true);
    expect(analyzed.find((row) => row.bootstrapType === 'comparative_assertion')?.matchedByCategory).toBe(true);
    expect(analyzed.find((row) => row.bootstrapType === 'recommendation')?.matchedByCategory).toBe(true);
  });

  it('reports complete coverage when all bootstrap rows map onto current legacy surfaces', () => {
    const rows: readonly BootstrapClaimRow[] = [
      {
        claimId: 'bootstrap-001',
        claim: {
          id: 'c-opus-ent',
          type: 'entity_reference',
          category: 'identity_claim',
          text: 'Opus One',
          entityId: 'opus-one-2018',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.9,
        shadowAnswerText: 'Opus One 2018 is a flagship Napa Valley red wine from the Opus One Winery.',
      },
      {
        claimId: 'bootstrap-008',
        claim: {
          id: 'c-sassicaia-pairing',
          type: 'pairing_assertion',
          category: 'semantic_claim',
          text: 'Sassicaia pairs well with grilled ribeye steak',
          entityId: 'sassicaia-2018',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.5,
        shadowAnswerText: 'Sassicaia 2018 pairs well with grilled ribeye and hearty red meat dishes.',
      },
      {
        claimId: 'bootstrap-012',
        claim: {
          id: 'c-grange-compare',
          type: 'comparative_assertion',
          category: 'comparative_claim',
          text: 'Penfolds Grange is more powerful than a traditional Barolo',
          entityId: 'penfolds-grange-2017',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.5,
        shadowAnswerText: 'Penfolds Grange is more powerful and concentrated than a traditional Barolo.',
      },
      {
        claimId: 'bootstrap-015',
        claim: {
          id: 'c-masi-rec',
          type: 'recommendation',
          category: 'semantic_claim',
          text: 'recommended for a cold winter evening',
          entityId: 'masi-amarone',
        },
        expectedVerdict: 'entailed',
        expectedConfidenceMin: 0.3,
        shadowAnswerText: 'Masi Amarone is recommended for a cold winter evening near the fireplace.',
      },
    ];

    const report = buildReport('test-fixture', rows);
    expect(report.coverage).toBe(1);
    expect(report.unmatchedRows).toBe(0);
    expect(report.byBootstrapType.entity_reference.matched).toBe(1);
    expect(report.byBootstrapType.pairing_assertion.matched).toBe(1);
    expect(report.byBootstrapType.comparative_assertion.matched).toBe(1);
    expect(report.byBootstrapType.recommendation.matched).toBe(1);
  });
});
