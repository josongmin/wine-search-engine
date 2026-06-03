import { describe, expect, it } from 'vitest';
import {
  buildShadowReport,
  DEFAULT_CUTOVER_GATE,
  type ShadowRow,
} from '../../../scripts/eval/lookup-v2-shadow-metrics.js';

const OPUS = 'opus-one-2018';

function rows(): ShadowRow[] {
  return [
    // exact entity — both correct
    { qid: 'q1', query: 'Opus One 2018', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'resolved', topEntityId: OPUS }, v2: { status: 'resolved', topEntityId: OPUS } },
    // noisy typo — V1 wrong-resolves, V2 correctly fails (the core V2 win)
    { qid: 'q2', query: 'opu one', expectedStatus: 'failed', v1: { status: 'resolved', topEntityId: OPUS }, v2: { status: 'failed' } },
    // concept query — V1 resolves (wrong), V2 redirects
    { qid: 'q3', query: '까쇼', expectedStatus: 'redirect_discovery', v1: { status: 'resolved', topEntityId: 'some-cab' }, v2: { status: 'redirect_discovery' } },
  ];
}

describe('buildShadowReport (T-ELV2-08 cutover gate)', () => {
  it('credits V2 for stopping V1 wrong-positives and passes the gate', () => {
    const report = buildShadowReport(rows());
    expect(report.v1.wrongPositive).toBe(2); // opu one + 까쇼 wrong-resolved
    expect(report.v2.wrongPositive).toBe(0);
    expect(report.improvements).toBe(2);
    expect(report.regressions).toBe(0);
    expect(report.v2ConceptRedirectAccuracy).toBe(1);
    expect(report.gate.pass).toBe(true);
  });

  it('fails the gate when V2 introduces a wrong-positive that V1 did not have', () => {
    const r: ShadowRow[] = [
      { qid: 'a', query: 'Opus One 2018', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'resolved', topEntityId: OPUS }, v2: { status: 'resolved', topEntityId: OPUS } },
      // V1 correctly fails the typo; V2 wrong-resolves it → regression + new wrong-positive
      { qid: 'b', query: 'opu one', expectedStatus: 'failed', v1: { status: 'failed' }, v2: { status: 'resolved', topEntityId: OPUS } },
    ];
    const report = buildShadowReport(r);
    expect(report.v1.wrongPositive).toBe(0);
    expect(report.v2.wrongPositive).toBe(1);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons.join(' ')).toMatch(/wrong-positive/i);
  });

  it('fails the gate when concept-redirect accuracy is below the floor', () => {
    const r: ShadowRow[] = [
      { qid: 'c1', query: '까쇼', expectedStatus: 'redirect_discovery', v1: { status: 'failed' }, v2: { status: 'failed' } },
      { qid: 'c2', query: 'Pinot Noir', expectedStatus: 'redirect_discovery', v1: { status: 'failed' }, v2: { status: 'redirect_discovery' } },
    ];
    const report = buildShadowReport(r);
    expect(report.v2ConceptRedirectAccuracy).toBe(0.5);
    expect(report.gate.pass).toBe(false);
  });

  it('treats a resolve to the wrong entity as a wrong-positive', () => {
    const r: ShadowRow[] = [
      { qid: 'w', query: 'Opus One', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'resolved', topEntityId: OPUS }, v2: { status: 'resolved', topEntityId: 'opus-one-2019' } },
    ];
    const report = buildShadowReport(r);
    expect(report.v2.wrongPositive).toBe(1);
    expect(report.v2.correct).toBe(0);
  });

  it('uses the conservative default gate thresholds', () => {
    expect(DEFAULT_CUTOVER_GATE.wrongPositiveRatioMax).toBe(1.0);
    expect(DEFAULT_CUTOVER_GATE.conceptRedirectAccuracyMin).toBeGreaterThanOrEqual(0.9);
    expect(DEFAULT_CUTOVER_GATE.requireNonDegenerate).toBe(true);
  });

  it('FAILS a degenerate run where neither engine resolved any expected-resolve row', () => {
    // The exact degraded shape the audit flagged: expected-resolve entities, but
    // both V1 and V2 abstain on all of them. Precision gates alone would PASS this
    // (0 wrong-positives, equal correct-rate); the non-degeneracy gate rejects it.
    const r: ShadowRow[] = [
      { qid: 'd1', query: 'Opus One 2018', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'failed' }, v2: { status: 'failed' } },
      { qid: 'd2', query: 'Sassicaia 2019', expectedStatus: 'resolved', expectedLabelHint: 'sassicaia', v1: { status: 'failed' }, v2: { status: 'failed' } },
    ];
    const report = buildShadowReport(r);
    expect(report.v1.wrongPositive).toBe(0);
    expect(report.v2.wrongPositive).toBe(0);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons.join(' ')).toMatch(/degenerate/i);
  });

  it('does NOT fire the non-degeneracy gate when V2 resolves correctly', () => {
    const r: ShadowRow[] = [
      { qid: 'n1', query: 'Opus One 2018', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'failed' }, v2: { status: 'resolved', topEntityId: OPUS } },
    ];
    const report = buildShadowReport(r);
    expect(report.gate.reasons.join(' ')).not.toMatch(/degenerate/i);
  });

  it('FAILS (asymmetric) when V1 resolves but V2 — the cutover target — resolves none', () => {
    // Precision-first V2 that abstains on every hot entity must NOT pass vacuously
    // off redirect/failed rows just because V1 happened to resolve one.
    const r: ShadowRow[] = [
      { qid: 'a1', query: 'Opus One 2018', expectedStatus: 'resolved', expectedEntityId: OPUS, v1: { status: 'resolved', topEntityId: OPUS }, v2: { status: 'ambiguous' } },
      { qid: 'a2', query: '까쇼', expectedStatus: 'redirect_discovery', v1: { status: 'redirect_discovery' }, v2: { status: 'redirect_discovery' } },
    ];
    const report = buildShadowReport(r);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons.join(' ')).toMatch(/V2 resolved 0/i);
  });

  it('does NOT fire the non-degeneracy gate on a corpus with zero expected-resolve rows', () => {
    const r: ShadowRow[] = [
      { qid: 'z1', query: '까쇼', expectedStatus: 'redirect_discovery', v1: { status: 'redirect_discovery' }, v2: { status: 'redirect_discovery' } },
    ];
    const report = buildShadowReport(r);
    expect(report.gate.reasons.join(' ')).not.toMatch(/degenerate/i);
  });

  it('scores correctness by label hint when no canonical id is present (hotset path)', () => {
    const r: ShadowRow[] = [
      // hint matches the resolved label (case/punctuation-insensitive) → correct
      { qid: 'h1', query: 'Dom Perignon', expectedStatus: 'resolved', expectedLabelHint: 'dom perignon', v1: { status: 'failed' }, v2: { status: 'resolved', topLabel: 'Dom Pérignon 2013' } },
      // resolved to a label that does NOT contain the hint → wrong-positive
      { qid: 'h2', query: 'Sassicaia', expectedStatus: 'resolved', expectedLabelHint: 'sassicaia', v1: { status: 'failed' }, v2: { status: 'resolved', topLabel: 'Tignanello 2019' } },
    ];
    const report = buildShadowReport(r);
    expect(report.v2.correct).toBe(1);
    expect(report.v2.wrongPositive).toBe(1);
    expect(report.improvements).toBe(1);
  });

  it('treats multiple accepted abstention statuses as correct for precision-first typo rows', () => {
    const r: ShadowRow[] = [
      {
        qid: 'm1',
        query: 'opu one',
        expectedStatus: 'failed',
        acceptedStatuses: ['failed', 'ambiguous'],
        v1: { status: 'failed' },
        v2: { status: 'ambiguous' },
      },
    ];
    const report = buildShadowReport(r);
    expect(report.v1.correct).toBe(1);
    expect(report.v2.correct).toBe(1);
    expect(report.v2.wrongPositive).toBe(0);
    expect(report.gate.pass).toBe(true);
  });
});
