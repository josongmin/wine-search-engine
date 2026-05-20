/**
 * Regression tests for `agent-situational-query-policy` precision (maturity 2 → 3).
 *
 * Audit-identified bugs:
 *  - "tasting notes" was falsely matched as "online tasting" (substring-level
 *    bug — `online_tasting` keyword detection did not require contextual
 *    indicators around "tasting").
 *  - OOD alcohol redirect destroyed valid pairing intent
 *    (e.g. "beer that pairs with steak" lost its pairing constraint).
 *
 * This file pins phrase-level parsing + pairing-intent preservation in the
 * stable regression lane so the policy cannot regress.
 *
 * Non-ASCII boundaries deliberately avoid `\b` (CLAUDE.md rule 8). All Korean
 * assertions match the Korean equivalent of the English assertion.
 */

import { describe, expect, it } from 'vitest';
import {
  buildOutOfDomainWineRedirectAnswer,
  isAccessibleOnlineTastingQuery,
  isWineOutOfDomainAlcoholQuery,
} from '../../src/application/agent/agent-situational-query-policy.js';

describe('agent-situational-query-policy: online-tasting precision', () => {
  it('rejects tasting-notes as non-situational (English)', () => {
    // Adversarial: contains "tasting" but is purely a tasting-notes request.
    const accessibleAddOn = ' available at the supermarket';
    expect(isAccessibleOnlineTastingQuery('tasting notes for Opus One' + accessibleAddOn)).toBe(false);
  });

  it('rejects tasting-notes as non-situational (Korean equivalent)', () => {
    // "오푸스 원의 시음 노트" — tasting-notes request, NOT an online tasting.
    expect(isAccessibleOnlineTastingQuery('오푸스 원의 시음 노트, 모두 살 수 있는 와인')).toBe(false);
  });

  it('detects accessible online tasting session (English)', () => {
    expect(
      isAccessibleOnlineTastingQuery('online tasting session this Friday, available at the supermarket'),
    ).toBe(true);
  });

  it('detects accessible online tasting (Korean 실시간 와인 시음회)', () => {
    expect(
      isAccessibleOnlineTastingQuery('실시간 와인 시음회, 참가자 모두 살 수 있는 와인'),
    ).toBe(true);
  });

  it('detects mixed Korean/English online tasting phrasing', () => {
    expect(
      isAccessibleOnlineTastingQuery('online 와인 tasting session, available to all participants'),
    ).toBe(true);
  });

  it('does not trigger on plain wine queries', () => {
    expect(isAccessibleOnlineTastingQuery('best Cabernet Sauvignon under $50')).toBe(false);
    expect(isAccessibleOnlineTastingQuery('오푸스 원 추천')).toBe(false);
  });

  it('does not throw and returns false for empty query', () => {
    expect(isAccessibleOnlineTastingQuery('')).toBe(false);
  });

  it('does not throw and returns false for whitespace-only query', () => {
    expect(isAccessibleOnlineTastingQuery('   \t\n  ')).toBe(false);
  });
});

describe('agent-situational-query-policy: OOD alcohol classification', () => {
  it('classifies beer-pairing query as OOD alcohol', () => {
    expect(isWineOutOfDomainAlcoholQuery('beer that pairs with steak')).toBe(true);
  });

  it('classifies whisky recommendation query as OOD alcohol (Korean)', () => {
    expect(isWineOutOfDomainAlcoholQuery('위스키 추천')).toBe(true);
  });

  it('classifies cocktail-recipes query as OOD alcohol', () => {
    // Cocktail is wine-adjacent but NOT in wine domain.
    expect(isWineOutOfDomainAlcoholQuery('cocktail recipes')).toBe(true);
  });

  it('does not classify plain wine queries as OOD', () => {
    expect(isWineOutOfDomainAlcoholQuery('best Cabernet Sauvignon under $50')).toBe(false);
    expect(isWineOutOfDomainAlcoholQuery('오푸스 원 추천')).toBe(false);
  });

  it('does not throw on empty / whitespace-only query', () => {
    expect(isWineOutOfDomainAlcoholQuery('')).toBe(false);
    expect(isWineOutOfDomainAlcoholQuery('   ')).toBe(false);
  });
});

describe('agent-situational-query-policy: OOD redirect preserves pairing intent', () => {
  it('preserves pairing intent for beer+steak (English)', () => {
    const redirect = buildOutOfDomainWineRedirectAnswer(false, {
      query: 'beer that pairs with steak',
    });
    // Must keep the pairing constraint visible to the user.
    expect(redirect.toLowerCase()).toContain('steak');
    expect(redirect.toLowerCase()).toContain('pair');
    // And must still redirect to wine.
    expect(redirect.toLowerCase()).toContain('wine');
  });

  it('preserves pairing intent for Korean alcohol-pairing query', () => {
    // "스테이크에 어울리는 맥주" — beer that pairs with steak.
    const redirect = buildOutOfDomainWineRedirectAnswer(true, {
      query: '스테이크에 어울리는 맥주',
    });
    expect(redirect).toContain('스테이크');
    // Must still redirect to wine.
    expect(redirect).toContain('와인');
  });

  it('omits pairing preservation when no pairing markers (위스키 추천)', () => {
    const redirect = buildOutOfDomainWineRedirectAnswer(true, {
      query: '위스키 추천',
    });
    // No pairing marker → no "어울리는" follow-on in the redirect.
    expect(redirect).not.toContain('어울리는');
    expect(redirect).toContain('와인');
  });

  it('omits pairing preservation when no pairing markers (cocktail recipes)', () => {
    const redirect = buildOutOfDomainWineRedirectAnswer(false, {
      query: 'cocktail recipes',
    });
    // No "pair" verb in the query → enrichment is skipped.
    expect(redirect.toLowerCase()).not.toContain('pairs with');
    expect(redirect.toLowerCase()).toContain('wine');
  });

  it('is backward-compatible: redirect without options returns boilerplate', () => {
    const en = buildOutOfDomainWineRedirectAnswer(false);
    const ko = buildOutOfDomainWineRedirectAnswer(true);
    expect(en.toLowerCase()).toContain('wine');
    expect(ko).toContain('와인');
  });
});
