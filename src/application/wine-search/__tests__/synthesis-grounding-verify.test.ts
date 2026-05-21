import { describe, expect, it } from 'vitest';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import {
  collectGroundingFacts,
  normalizeClaimSurface,
  verifyAnswerGrounding,
} from '../synthesis-grounding-verify.js';

function searchOutcome(
  wines: ReadonlyArray<{ label?: string; region?: string; vintage?: number; grapes?: readonly string[] }>,
  opts?: { kind?: ToolOutcome['kind'] },
): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_wines',
    kind: opts?.kind ?? 'success',
    durationMs: 1,
    result: {
      queryType: 'search',
      results: wines.map((w) => ({
        entity: {
          ...(w.label !== undefined ? { canonicalLabel: w.label } : {}),
          ...(w.region !== undefined ? { region: w.region } : {}),
          ...(w.vintage !== undefined ? { vintage: w.vintage } : {}),
          ...(w.grapes !== undefined ? { grapes: [...w.grapes] } : {}),
        },
      })),
    },
  };
}

function groundingJsonOutcome(json: unknown): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_wines',
    kind: 'success',
    durationMs: 1,
    result: `Some summary text\nGROUNDING_JSON: ${JSON.stringify(json)}`,
  };
}

describe('synthesis-grounding-verify — normalizeClaimSurface', () => {
  it('NFC + lowercase + strips Korean josa + collapses whitespace', () => {
    expect(normalizeClaimSurface('샤또  무통은')).toBe('샤또 무통');
    expect(normalizeClaimSurface('Château  Margaux')).toBe('château margaux');
  });

  it('is a no-op-safe for empty and ASCII input', () => {
    expect(normalizeClaimSurface('')).toBe('');
    expect(normalizeClaimSurface('Opus One')).toBe('opus one');
  });
});

describe('synthesis-grounding-verify — collectGroundingFacts', () => {
  it('builds the union across multiple outcomes (structured + GROUNDING_JSON)', () => {
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A', region: 'Bordeaux', vintage: 2018, grapes: ['Merlot'] }]),
      groundingJsonOutcome({ wines: [{ canonical_label: 'Wine B', region: 'Rioja', vintage: 2019 }] }),
    ]);
    expect(facts.hasAnyFact).toBe(true);
    expect(facts.labels.has('wine a')).toBe(true);
    expect(facts.labels.has('wine b')).toBe(true);
    expect(facts.regions.has('bordeaux')).toBe(true);
    expect(facts.vintages.has('2018')).toBe(true);
    expect(facts.vintages.has('2019')).toBe(true);
    expect(facts.grapes.has('merlot')).toBe(true);
  });

  it('ignores non-grounding outcome kinds (errors/timeouts)', () => {
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A' }], { kind: 'timeout' }),
    ]);
    expect(facts.hasAnyFact).toBe(false);
  });

  it('returns hasAnyFact=false for empty outcomes', () => {
    expect(collectGroundingFacts([]).hasAnyFact).toBe(false);
  });
});

describe('synthesis-grounding-verify — verifyAnswerGrounding', () => {
  const facts = collectGroundingFacts([
    searchOutcome([{ label: 'Wine A', region: 'Bordeaux', vintage: 2018 }]),
  ]);

  it('treats no facts as grounded (defensive)', () => {
    const empty = collectGroundingFacts([]);
    expect(verifyAnswerGrounding('anything', ['Wine Z'], empty).grounded).toBe(true);
  });

  it('grounded when a label citation matches a grounded label', () => {
    const r = verifyAnswerGrounding('I recommend Wine A.', ['Wine A'], facts);
    expect(r.grounded).toBe(true);
    expect(r.ungroundedClaims).toEqual([]);
  });

  it('ungrounded when a label citation is absent from grounding', () => {
    const r = verifyAnswerGrounding('I recommend Wine B.', ['Wine B'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('wine b');
  });

  it('skips entity-id-shaped citations (wine-001, uuids, integers)', () => {
    const r = verifyAnswerGrounding('paraphrased prose', ['wine-001', '42'], facts);
    expect(r.grounded).toBe(true);
  });

  it('flags an ungrounded vintage asserted in the answer text', () => {
    const r = verifyAnswerGrounding('The 2015 vintage is great.', ['Wine A'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('2015');
  });

  it('passes a grounded vintage assertion', () => {
    const r = verifyAnswerGrounding('The 2018 Wine A is great.', ['Wine A'], facts);
    expect(r.grounded).toBe(true);
  });

  it('does NOT flag a faithful paraphrase that cites nothing label-shaped', () => {
    const r = verifyAnswerGrounding('A lovely Bordeaux for tonight.', ['wine-001'], facts);
    expect(r.grounded).toBe(true);
  });

  it('accepts a shortened label citation that is a substring of the grounded label', () => {
    const longFacts = collectGroundingFacts([
      searchOutcome([{ label: 'Château Margaux Grand Vin 2015', vintage: 2015 }]),
    ]);
    const r = verifyAnswerGrounding('Try Château Margaux.', ['Château Margaux'], longFacts);
    expect(r.grounded).toBe(true);
  });

  it('handles Korean label citations with josa normalization', () => {
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '샤또 무통' }])]);
    const r = verifyAnswerGrounding('샤또 무통을 추천합니다.', ['샤또 무통은'], krFacts);
    expect(r.grounded).toBe(true);
  });
});
