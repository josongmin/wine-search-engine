import { describe, it, expect } from 'vitest';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  detectQueryIntent,
  EXACT_ANCHOR_CONFIDENCE,
  type IntentDetectionAnchorExtractor,
} from '../../../src/domain/query/service/planner-intent-detection.js';
import type { AnchorCandidate } from '../../../src/domain/query/model/anchor-candidate.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

function anchor(confidence: number): AnchorCandidate {
  return {
    surfaceForm: 'test wine',
    normalizedForm: 'test wine',
    candidateEntityIds: [createEntityId()],
    confidence,
  };
}

function multiEntityAnchor(confidence: number): AnchorCandidate {
  return {
    surfaceForm: 'barolo',
    normalizedForm: 'barolo',
    candidateEntityIds: [createEntityId(), createEntityId()],
    confidence,
  };
}

const noopExtractor: IntentDetectionAnchorExtractor = {
  hasComparisonMarkers: () => false,
  hasKoreanMixedQueryMarkers: () => false,
};

describe('detectQueryIntent', () => {
  it('returns entity_exact for strong anchor without price/constraint keywords', () => {
    expect(
      detectQueryIntent('opus one', [anchor(EXACT_ANCHOR_CONFIDENCE + 0.05)], noopExtractor),
    ).toBe('entity_exact');
  });

  it('returns mixed_query when strong anchor and color constraint keyword', () => {
    expect(
      detectQueryIntent(
        'opus one red wine',
        [anchor(EXACT_ANCHOR_CONFIDENCE + 0.05)],
        noopExtractor,
      ),
    ).toBe('mixed_query');
  });

  it('returns entity_fuzzy for weak anchor only', () => {
    const c = (ANCHOR_PRESENT_CONFIDENCE + EXACT_ANCHOR_CONFIDENCE) / 2;
    expect(detectQueryIntent('rare bottle', [anchor(c)], noopExtractor)).toBe('entity_fuzzy');
  });

  it('returns budget_search when price keyword and no anchor', () => {
    expect(detectQueryIntent('under $30', [], noopExtractor)).toBe('budget_search');
  });

  it('returns pairing_search when pairing keyword and no anchor', () => {
    expect(detectQueryIntent('wine pairing with steak', [], noopExtractor)).toBe('pairing_search');
  });

  it('returns pairing_search for mixed-script food pairing queries', () => {
    expect(detectQueryIntent('Cheese에 어울리는 와인', [], noopExtractor)).toBe('pairing_search');
    expect(detectQueryIntent('Pasta랑 마실 와인', [], noopExtractor)).toBe('pairing_search');
    expect(detectQueryIntent('Cured Meat에 어울리는 와인', [], noopExtractor)).toBe('pairing_search');
  });

  it('routes occasion-driven recommendation queries to pairing_search even without food evidence', () => {
    const weakAnchor = anchor((ANCHOR_PRESENT_CONFIDENCE + EXACT_ANCHOR_CONFIDENCE) / 2);
    expect(
      detectQueryIntent('회사 회식 10명 레드 와인 추천 party', [weakAnchor], noopExtractor),
    ).toBe('pairing_search');
    expect(
      detectQueryIntent('캠핑 가는데 스크류캡이고 차갑게 마실 수 있는 거', [weakAnchor], noopExtractor),
    ).toBe('pairing_search');
  });

  it('treats strong anchored occasion queries as pairing_search', () => {
    expect(
      detectQueryIntent('opus one anniversary gift', [anchor(EXACT_ANCHOR_CONFIDENCE + 0.05)], noopExtractor),
    ).toBe('pairing_search');
  });

  it('does not collapse prestige-only recommendation queries into budget_search', () => {
    expect(detectQueryIntent('고급 와인 추천', [], noopExtractor)).toBe('semantic_discovery');
    expect(detectQueryIntent('premium wine recommendation', [], noopExtractor)).toBe('semantic_discovery');
  });

  it('returns facet_search when only constraint keywords', () => {
    expect(detectQueryIntent('dry red wine from burgundy', [], noopExtractor)).toBe('facet_search');
  });

  it('routes top-level appellation/category anchors with competing entities to facet_search', () => {
    expect(
      detectQueryIntent('barolo', [multiEntityAnchor(EXACT_ANCHOR_CONFIDENCE + 0.05)], noopExtractor),
    ).toBe('facet_search');
    expect(
      detectQueryIntent('bordeaux', [multiEntityAnchor(EXACT_ANCHOR_CONFIDENCE + 0.05)], noopExtractor),
    ).toBe('facet_search');
  });

  it('returns semantic_discovery when empty query and no anchors', () => {
    expect(detectQueryIntent('   ', [], noopExtractor)).toBe('semantic_discovery');
  });

  it('prefers comparison_search when comparison marker and anchor', () => {
    const extractor: IntentDetectionAnchorExtractor = {
      hasComparisonMarkers: () => true,
      hasKoreanMixedQueryMarkers: () => false,
    };
    expect(
      detectQueryIntent('a vs b wine', [anchor(ANCHOR_PRESENT_CONFIDENCE + 0.02)], extractor),
    ).toBe('comparison_search');
  });

  it('prefers mixed_query when Korean mixed marker and anchor', () => {
    const extractor: IntentDetectionAnchorExtractor = {
      hasComparisonMarkers: () => false,
      hasKoreanMixedQueryMarkers: () => true,
    };
    expect(
      detectQueryIntent('쿼리', [anchor(ANCHOR_PRESENT_CONFIDENCE + 0.02)], extractor),
    ).toBe('mixed_query');
  });
});
