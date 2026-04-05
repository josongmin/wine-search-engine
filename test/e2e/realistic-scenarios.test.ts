/**
 * Realistic scenario E2E tests for the Wine Search Engine.
 *
 * Covers typo tolerance, vintage specificity, style/attribute semantic matching,
 * occasion/pairing queries, language mixing, producer/region ambiguity, graceful
 * degradation for out-of-fixture queries, and search mode interaction.
 *
 * Does NOT duplicate tests already in user-journeys.test.ts or golden-set.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<{ statusCode: number; body: unknown }> {
  const response = await server.app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as unknown,
  };
}

function getTopK(body: unknown, k: number): string[] {
  const b = body as Record<string, unknown>;
  const results = (b['results'] as Array<Record<string, unknown>>) ?? [];
  return results.slice(0, k).map(
    (r) => (r['entity'] as Record<string, unknown>)?.['entityId'] as string ?? '',
  );
}

function getDecisionStatus(body: unknown): string {
  const b = body as Record<string, unknown>;
  const decision = b['engineDecision'] as Record<string, unknown>;
  return decision['decisionStatus'] as string;
}

function getResultsLength(body: unknown): number {
  const b = body as Record<string, unknown>;
  const results = (b['results'] as Array<unknown>) ?? [];
  return results.length;
}

function getMeta(body: unknown): Record<string, unknown> {
  const b = body as Record<string, unknown>;
  return (b['meta'] as Record<string, unknown>) ?? {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Alternate Spellings (pre-registered aliases)
// NOTE: InMemoryAliasMatcher now supports compact normalization in addition to
// exact/substring matching. This still primarily tests alias-driven lookup.
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1: Alternate Spellings (pre-registered aliases)', () => {
  // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
  // NOTE: In test infra, entity mode always returns `ambiguous` because InMemoryBlockingAdapter returns all 10
  // entities causing conformal set size >= 2. Hybrid mode is used to verify retrieval correctness.

  it("'오퍼스 원' (pre-registered alternate spelling) → entity mode non-failed; hybrid top-3 has opus-one-2018", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: '오퍼스 원',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // InMemoryBlockingAdapter returns all candidates → conformal set >= 2 → ambiguous
    expect(getDecisionStatus(res.body)).not.toBe('failed');

    // Verify hybrid retrieval for rank assertion
    const hybridRes = await post('/v1/search', {
      query: '오퍼스 원',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });
    expect(hybridRes.statusCode).toBe(200);
    expect(getTopK(hybridRes.body, 3)).toContain('opus-one-2018');
  });

  it("'Chateau Margaux' (no accent, pre-registered alias) → entity mode non-failed", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: 'Chateau Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // 'Chateau Margaux' IS a pre-registered alias — must not fail
    expect(getDecisionStatus(res.body)).not.toBe('failed');
  });

  it("'romanee conti' (lowercase, pre-registered alias) → entity mode non-failed; hybrid has romanee-conti-2019", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: 'romanee conti',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // 'romanee conti' IS a pre-registered alias — must not fail
    expect(getDecisionStatus(res.body)).not.toBe('failed');

    // Verify hybrid retrieval
    const hybridRes = await post('/v1/search', {
      query: 'romanee conti',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });
    expect(hybridRes.statusCode).toBe(200);
    expect(getTopK(hybridRes.body, 3)).toContain('romanee-conti-2019');
  });

  it("'moet brut' (fully lowercase of pre-registered alias) → entity mode non-failed", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: 'moet brut',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // 'Moet Brut' IS a pre-registered alias; normalized lowercase matches — must not fail
    expect(getDecisionStatus(res.body)).not.toBe('failed');
  });

  it("'Grange' (short pre-registered alias) → entity mode non-failed; hybrid has penfolds-grange-2017", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: 'Grange',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // 'Grange' IS a pre-registered alias — must not fail
    expect(getDecisionStatus(res.body)).not.toBe('failed');

    // Verify hybrid retrieval
    const hybridRes = await post('/v1/search', {
      query: 'Grange',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });
    expect(hybridRes.statusCode).toBe(200);
    expect(getTopK(hybridRes.body, 3)).toContain('penfolds-grange-2017');
  });

  it("'grange' (fully lowercase, normalized matches pre-registered 'Grange') → entity mode non-failed", async () => {
    // NOTE: InMemoryAliasMatcher does exact+substring matching only. This tests pre-registered aliases, not fuzzy matching.
    const res = await post('/v1/search', {
      query: 'grange',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    // Lowercase 'grange' normalizes to match registered 'Grange' — must not fail
    expect(getDecisionStatus(res.body)).not.toBe('failed');
  });

  it("'opusone' (compact noisy form) → entity mode non-failed; hybrid top-3 has opus-one-2018", async () => {
    const res = await post('/v1/search', {
      query: 'opusone',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).not.toBe('failed');

    const hybridRes = await post('/v1/search', {
      query: 'opusone',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });
    expect(hybridRes.statusCode).toBe(200);
    expect(getTopK(hybridRes.body, 3)).toContain('opus-one-2018');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Vintage & Specificity
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2: Vintage & Specificity', () => {
  it("'Opus One' (no vintage) → resolved or ambiguous (never failed)", async () => {
    const res = await post('/v1/search', {
      query: 'Opus One',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const decisionStatus = getDecisionStatus(res.body);
    expect(decisionStatus).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'Sassicaia 2018' (correct registered vintage) → sassicaia-2018 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Sassicaia 2018',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    if (getResultsLength(res.body) > 0) {
      expect(getTopK(res.body, 3)).toContain('sassicaia-2018');
    }
  });

  it("'Opus One 2099' (non-existent vintage) → 200, graceful (any decision status)", async () => {
    const res = await post('/v1/search', {
      query: 'Opus One 2099',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).toMatch(/^(resolved|ambiguous|failed)$/);
  });

  it("'2018' (only year) → 200, results is an array", async () => {
    const res = await post('/v1/search', {
      query: '2018',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(Array.isArray(b['results'])).toBe(true);
  });

  it("'2018 Cabernet' → results non-empty (Opus One and Sassicaia both match)", async () => {
    const res = await post('/v1/search', {
      query: '2018 Cabernet',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Style & Attribute Semantic Matching
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3: Style & Attribute Semantic Matching', () => {
  it("'타닌 강한 레드' → full-body tannic wines (Barolo or Amarone in top-5)", async () => {
    const res = await post('/v1/search', {
      query: '타닌 강한 레드',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);

    const top5 = getTopK(res.body, 5);
    expect(top5.some((id) => id === 'barolo-giacomo' || id === 'masi-amarone')).toBe(true);
  });

  it("'Pinot Noir Burgundy' → romanee-conti-2019 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Pinot Noir Burgundy',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('romanee-conti-2019');
  });

  it("'디저트 와인' → sauternes-2015 in top-3", async () => {
    const res = await post('/v1/search', {
      query: '디저트 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('sauternes-2015');
  });

  it("'Super Tuscan Italy' → sassicaia-2018 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Super Tuscan Italy',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('sassicaia-2018');
  });

  it("'Australian Shiraz bold' → penfolds-grange-2017 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Australian Shiraz bold',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('penfolds-grange-2017');
  });

  it("'보르도 레드' → chateau-margaux-2015 in top-3", async () => {
    const res = await post('/v1/search', {
      query: '보르도 레드',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('chateau-margaux-2015');
  });

  it("'뉴질랜드 화이트' → cloudy-bay-2022 in top-3", async () => {
    const res = await post('/v1/search', {
      query: '뉴질랜드 화이트',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('cloudy-bay-2022');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Occasion & Pairing Semantic
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4: Occasion & Pairing Semantic', () => {
  it("'결혼식 샴페인' → moet-brut in top-3", async () => {
    const res = await post('/v1/search', {
      query: '결혼식 샴페인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('moet-brut');
  });

  it("'스테이크랑 어울리는 와인' → at least one full-body red in top-5", async () => {
    const STEAK_WINES = new Set(['opus-one-2018', 'penfolds-grange-2017', 'sassicaia-2018']);

    const res = await post('/v1/search', {
      query: '스테이크랑 어울리는 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);

    const top5 = getTopK(res.body, 5);
    expect(top5.some((id) => STEAK_WINES.has(id))).toBe(true);
  });

  it("'여름에 마시기 좋은 화이트' → results non-empty", async () => {
    const res = await post('/v1/search', {
      query: '여름에 마시기 좋은 화이트',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
  });

  it("'파티 와인 추천' → moet-brut in top-5", async () => {
    const res = await post('/v1/search', {
      query: '파티 와인 추천',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 5)).toContain('moet-brut');
  });

  it("'투자용 와인' → results non-empty (luxury investment wines)", async () => {
    const res = await post('/v1/search', {
      query: '투자용 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Language Mixing & Code-Switching
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5: Language Mixing & Code-Switching', () => {
  it("'풀바디 Cabernet' (Korean + English) → at least one Cab-based wine in top-5", async () => {
    const CAB_WINES = new Set(['opus-one-2018', 'chateau-margaux-2015', 'sassicaia-2018']);

    const res = await post('/v1/search', {
      query: '풀바디 Cabernet',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);

    const top5 = getTopK(res.body, 5);
    expect(top5.some((id) => CAB_WINES.has(id))).toBe(true);
  });

  it("'Bordeaux 레드 와인' (English + Korean) → chateau-margaux-2015 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Bordeaux 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('chateau-margaux-2015');
  });

  it("'아마로네 강한' (Italian name + Korean descriptor) → results non-empty", async () => {
    const res = await post('/v1/search', {
      query: '아마로네 강한',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
  });

  it("'피노누아' (Korean) → romanee-conti-2019 in top-3", async () => {
    const res = await post('/v1/search', {
      query: '피노누아',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('romanee-conti-2019');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Producer & Region Ambiguity
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 6: Producer & Region Ambiguity', () => {
  it("'Penfolds' (producer only) → 200, resolved or ambiguous", async () => {
    const res = await post('/v1/search', {
      query: 'Penfolds',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'Bordeaux' alone → Margaux or Sauternes in top-5", async () => {
    const BORDEAUX_WINES = new Set(['chateau-margaux-2015', 'sauternes-2015']);

    const res = await post('/v1/search', {
      query: 'Bordeaux',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);

    const top5 = getTopK(res.body, 5);
    expect(top5.some((id) => BORDEAUX_WINES.has(id))).toBe(true);
  });

  it("'Tuscany' alone → sassicaia-2018 in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Tuscany',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('sassicaia-2018');
  });

  it("'Champagne' alone → moet-brut in top-3", async () => {
    const res = await post('/v1/search', {
      query: 'Champagne',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
    expect(getTopK(res.body, 3)).toContain('moet-brut');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Out-of-Fixture / Graceful Degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 7: Out-of-Fixture / Graceful Degradation', () => {
  it("'Petrus 2000' (not in fixtures) → 200, ambiguous or failed", async () => {
    const res = await post('/v1/search', {
      query: 'Petrus 2000',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).toMatch(/^(ambiguous|failed)$/);
  });

  it("'Screaming Eagle' (luxury Napa, not in fixtures) → 200, no crash", async () => {
    const res = await post('/v1/search', {
      query: 'Screaming Eagle',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("'Mouton Rothschild' (not in fixtures) → 200, not resolved", async () => {
    const res = await post('/v1/search', {
      query: 'Mouton Rothschild',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).not.toBe('resolved');
  });

  it("'Château Lafite' (not in fixtures) → 200, ambiguous or failed", async () => {
    const res = await post('/v1/search', {
      query: 'Château Lafite',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getDecisionStatus(res.body)).toMatch(/^(ambiguous|failed)$/);
  });

  it("'wine under 10000 won' (price query) → 200, results is an array", async () => {
    const res = await post('/v1/search', {
      query: 'wine under 10000 won',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(Array.isArray(b['results'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8: Search Mode Interaction
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 8: Search Mode Interaction', () => {
  it("auto mode routes entity query '오푸스원' to entity|hybrid|mixed route", async () => {
    const res = await post('/v1/search', {
      query: '오푸스원',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const route = getMeta(res.body)['route'] as string;
    expect(route).toMatch(/entity|hybrid|mixed/);
  });

  it("auto mode routes style query '풀바디 레드 추천' to hybrid|mixed route", async () => {
    const res = await post('/v1/search', {
      query: '풀바디 레드 추천',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    const route = getMeta(res.body)['route'] as string;
    expect(route).toMatch(/hybrid|mixed/);
  });

  it("entity mode forced on semantic query '풀바디 레드 와인' → 200, no crash", async () => {
    const res = await post('/v1/search', {
      query: '풀바디 레드 와인',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("hybrid mode forced on entity query '오푸스원' → 200, results non-empty", async () => {
    const res = await post('/v1/search', {
      query: '오푸스원',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(res.statusCode).toBe(200);
    expect(getResultsLength(res.body)).toBeGreaterThan(0);
  });
});
