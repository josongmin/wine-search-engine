import { describe, expect, it } from 'vitest';
import {
  shouldDowngradeForVintageMismatch,
  selectExplicitVintageFamilyMember,
  VINTAGE_MISMATCH_REASON_CODE,
  VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE,
  MIN_VINTAGE_SIBLING_CHANNEL_AGREEMENT,
} from '../../../src/domain/resolver/v2/vintage-guard.js';

/**
 * T-ELV2-08 cutover blocker: `오퍼스원 2019` must NOT wrong-resolve to
 * `Opus One 2018`. The guard downgrades that resolve to ambiguous; matching or
 * absent vintages do not downgrade (precision-first, exact year compare).
 */
describe('shouldDowngradeForVintageMismatch', () => {
  it('downgrades when the query vintage differs from the candidate vintage (the cutover blocker)', () => {
    expect(shouldDowngradeForVintageMismatch('오퍼스원 2019', 'Opus One 2018')).toBe(true);
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', 'Opus One 2018')).toBe(true);
    expect(shouldDowngradeForVintageMismatch('오퍼스 원 19', 'Opus One 2018')).toBe(true);
  });

  it('does NOT downgrade when the vintages match', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2018', 'Opus One 2018')).toBe(false);
    expect(shouldDowngradeForVintageMismatch('오퍼스원 2018', 'Opus One 2018')).toBe(false);
    expect(shouldDowngradeForVintageMismatch('오퍼스 원 18', 'Opus One 2018')).toBe(false);
  });

  it('does NOT downgrade when the query has no explicit vintage', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One', 'Opus One 2018')).toBe(false);
    expect(shouldDowngradeForVintageMismatch('오퍼스원', 'Opus One 2018')).toBe(false);
  });

  it('does NOT downgrade when the candidate label has no vintage (nothing to contradict)', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', 'Opus One')).toBe(false);
  });

  it('does NOT downgrade when there is no candidate label', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', undefined)).toBe(false);
  });

  it('exposes a stable reason code', () => {
    expect(VINTAGE_MISMATCH_REASON_CODE).toBe('vintage_mismatch_downgrade');
  });
});

/**
 * Vintage-aware family-member selection (the dual): an `ambiguous` verdict on an
 * explicit-vintage query is answerable when the pool hosts the EXACT requested
 * vintage as a unique, multi-channel-corroborated sibling — promote it instead of
 * abstaining. This closes the `슈발 블랑 2010`/`파비 2017` family-vintage residue
 * without resurrecting typo near-misses.
 */
describe('selectExplicitVintageFamilyMember', () => {
  const sibling = (entityId: string, canonicalLabel: string, channelAgreement = 3) => ({
    entityId,
    canonicalLabel,
    channelAgreement,
  });

  it('promotes the unique vintage-matching sibling over a vintage-blind incumbent', () => {
    // "칼롱 세귀르 2009": exact-safe incumbent is the 2003, the 2009 sibling is the answer.
    expect(
      selectExplicitVintageFamilyMember({
        query: '칼롱 세귀르 2009',
        candidates: [
          sibling('w-calon-2003', '2003 Château Calon-Ségur'),
          sibling('w-calon-2009', 'Château Calon-Ségur 2009'),
          sibling('w-calon-2020', 'Château Calon-Ségur 2020'),
        ],
      }),
    ).toBe('w-calon-2009');
  });

  it('promotes the matching sibling even when it is already the (collision) top', () => {
    // "파비 2017": top vintage already matches but the verdict is a family collision.
    expect(
      selectExplicitVintageFamilyMember({
        query: '파비 2017',
        candidates: [
          sibling('w-pavie-2017', 'Château Pavie 2017'),
          sibling('w-pavie-2014', 'Château Pavie 2014'),
          sibling('w-pavie-aromes-2009', '2009 Château Pavie Aromes de Pavie', 2),
        ],
      }),
    ).toBe('w-pavie-2017');
  });

  it('abstains (undefined) when no pooled candidate matches the query vintage', () => {
    expect(
      selectExplicitVintageFamilyMember({
        query: '칼롱 세귀르 2009',
        candidates: [sibling('w-calon-2003', '2003 Château Calon-Ségur')],
      }),
    ).toBeUndefined();
  });

  it('abstains when MORE THAN ONE candidate matches the query vintage (genuinely ambiguous)', () => {
    expect(
      selectExplicitVintageFamilyMember({
        query: '솔라이아 2016',
        candidates: [
          sibling('w-a-2016', 'Producer A Cuvee 2016'),
          sibling('w-b-2016', 'Producer B Cuvee 2016'),
        ],
      }),
    ).toBeUndefined();
  });

  it('abstains when the matching candidate lacks multi-channel corroboration (typo-recall guard)', () => {
    // A near-miss like "오푸스투 2018" that merely single-channel recalls a 2018
    // entity must NOT be promoted — channel agreement below the floor abstains.
    expect(
      selectExplicitVintageFamilyMember({
        query: '오푸스투 2018',
        candidates: [sibling('opus-one-2018', 'Opus One 2018', MIN_VINTAGE_SIBLING_CHANNEL_AGREEMENT - 1)],
      }),
    ).toBeUndefined();
  });

  it('abstains when the query carries no explicit vintage', () => {
    expect(
      selectExplicitVintageFamilyMember({
        query: '슈발 블랑',
        candidates: [sibling('w-cheval-2010', 'Château Cheval Blanc 2010')],
      }),
    ).toBeUndefined();
  });

  it('matches two-digit vintage suffixes via the query-aware vintage SSoT', () => {
    // "슈발 블랑 10" → 2010.
    expect(
      selectExplicitVintageFamilyMember({
        query: '슈발 블랑 10',
        candidates: [
          sibling('w-cheval-1990', '1990 Château Cheval Blanc'),
          sibling('w-cheval-2010', 'Château Cheval Blanc 2010'),
        ],
      }),
    ).toBe('w-cheval-2010');
  });

  it('exposes stable reason code + channel-agreement floor', () => {
    expect(VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE).toBe('vintage_family_member_resolved');
    expect(MIN_VINTAGE_SIBLING_CHANNEL_AGREEMENT).toBe(2);
  });
});
