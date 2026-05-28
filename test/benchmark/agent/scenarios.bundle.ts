/**
 * ADR-013 Phase 1c bundle bench scenarios.
 *
 * Three scenarios exercise the BundleSelector + graph-aware executor:
 *   1. 3-way pairing — appetiser / main / dessert each with its own wine
 *   2. XOR red-or-white — "취향에 따라 레드 또는 화이트"
 *   3. Shared-price-budget gift set — two wines, total ≤ ₩150k
 *
 * IDs start at 500 to avoid collisions with `scenarios.coverage.ts`
 * which occupies 200–499. Tier `extreme` mirrors the existing
 * multi-course pairing scenario (#57); the BundleSelector explicitly
 * targets this class of query.
 *
 * Acceptance targets: `scrInferred ≥ 80%`, `csrInferred ≥ 70%` per
 * ADR-013 cutover gate.
 */

import type { AgentBenchmarkScenario } from './scenario.js';

export const BUNDLE_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  {
    id: 500,
    tier: 'extreme',
    query: '웨딩 디너 코스요리 — 애피타이저용 화이트, 메인(양고기)용 레드, 디저트용 스위트, 각각 한 병씩 추천해줘',
    description: 'Bundle 3-way pairing (appetiser/main/dessert)',
    expectation: {
      maxSteps: 5,
      maxDurationMs: 90_000,
      maxTotalTokens: 12_000,
      answerMustMatch: [
        '(화이트|white)',
        '(레드|red)',
        '(스위트|sweet|dessert)',
      ],
      rubric:
        'Must recommend exactly three wines — one white (appetiser), one red (main), one sweet (dessert). Each recommendation must identify which course it pairs with.',
      expectedConstraints: {
        hard: [
          { attribute: 'wine_type', operator: '=', value: 'white' },
          { attribute: 'wine_type', operator: '=', value: 'red' },
          { attribute: 'wine_type', operator: '=', value: 'sweet' },
        ],
      },
      expectedEntities: [
        { surface: '화이트', canonical: 'white', type: 'wine_type' },
        { surface: '레드', canonical: 'red', type: 'wine_type' },
      ],
    },
  },
  {
    id: 501,
    tier: 'extreme',
    query: '취향에 따라 레드 또는 화이트 둘 중 하나 — 10만원 이하 추천',
    description: 'Bundle XOR red-or-white with price cap',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 40_000,
      maxTotalTokens: 8_000,
      priceBandKrw: { max: 100_000 },
      answerMustMatch: ['(레드|red|화이트|white)'],
      rubric:
        'Must recommend one wine — either red OR white (XOR). Answer must state which branch was picked and why; both branches at once is wrong (XOR, not AND).',
      expectedConstraints: {
        soft: [
          { attribute: 'price_usd', operator: '<=', value: 74.07 },
        ],
      },
      expectedEntities: [
        { surface: '레드', canonical: 'red', type: 'wine_type' },
        { surface: '화이트', canonical: 'white', type: 'wine_type' },
      ],
    },
  },
  {
    id: 502,
    tier: 'extreme',
    query: '부부 선물 세트 — 남편 취향 레드 한 병 + 아내 취향 화이트 한 병, 두 병 합쳐 15만원 이내',
    description: 'Bundle shared-price-budget gift set (2 wines, shared ceiling)',
    expectation: {
      maxSteps: 4,
      maxDurationMs: 60_000,
      maxTotalTokens: 10_000,
      priceBandKrw: { max: 150_000 },
      answerMustMatch: ['(레드|red)', '(화이트|white)'],
      answerMustNotMatch: ['(\\d{2,3}만원\\s*(이상|초과))'],
      rubric:
        'Must recommend exactly two wines (one red, one white) whose COMBINED price stays at or under 150,000 KRW. Single-wine answers are wrong; wines whose sum exceeds the ceiling are wrong.',
      expectedConstraints: {
        hard: [
          { attribute: 'wine_type', operator: '=', value: 'red' },
          { attribute: 'wine_type', operator: '=', value: 'white' },
        ],
        soft: [
          { attribute: 'price_usd', operator: '<=', value: 111.11 },
        ],
      },
      expectedEntities: [
        { surface: '레드', canonical: 'red', type: 'wine_type' },
        { surface: '화이트', canonical: 'white', type: 'wine_type' },
      ],
    },
  },
];
