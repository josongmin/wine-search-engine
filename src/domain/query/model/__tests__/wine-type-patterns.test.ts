import { describe, it, expect } from 'vitest';
import {
  WINE_TYPE_RULES,
  WINE_TYPE_DETECTION_PATTERNS,
  type WineTypeValue,
} from '../wine-type-patterns.js';

// ---------------------------------------------------------------------------
// Helper: find the first matching wine type for a query string
// ---------------------------------------------------------------------------

function detectWineType(query: string): WineTypeValue | undefined {
  for (const [pattern, value] of WINE_TYPE_RULES) {
    if (pattern.test(query)) return value;
  }
  return undefined;
}

function detectsAnyWineType(query: string): boolean {
  return WINE_TYPE_DETECTION_PATTERNS.some((re) => re.test(query));
}

// ---------------------------------------------------------------------------
// 1. 8가지 와인 타입 기본 매칭
// ---------------------------------------------------------------------------

describe('WINE_TYPE_RULES — 기본 영문 매칭', () => {
  const cases: [string, WineTypeValue][] = [
    ['red wine', 'red'],
    ['white wine', 'white'],
    ['rosé', 'rosé'],
    ['sparkling', 'sparkling'],
    ['natural wine', 'natural'],
    ['dessert wine', 'dessert'],
    ['fortified', 'fortified'],
    ['orange wine', 'orange'],
  ];

  it.each(cases)('"%s" → %s', (query, expected) => {
    expect(detectWineType(query)).toBe(expected);
  });

  it('dessert wines (복수형) 매칭', () => {
    expect(detectWineType('dessert wines')).toBe('dessert');
  });
});

// ---------------------------------------------------------------------------
// 2. 한국어 변형 매칭
// ---------------------------------------------------------------------------

describe('WINE_TYPE_RULES — 한국어 변형', () => {
  const cases: [string, WineTypeValue][] = [
    ['레드 와인', 'red'],
    ['화이트', 'white'],
    ['로제', 'rosé'],
    ['스파클링', 'sparkling'],
    ['디저트 와인', 'dessert'],
  ];

  it.each(cases)('"%s" → %s', (query, expected) => {
    expect(detectWineType(query)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. 우선순위: "sparkling rosé" → sparkling이 먼저 매칭
// ---------------------------------------------------------------------------

describe('WINE_TYPE_RULES — 우선순위', () => {
  it('"sparkling rosé" → sparkling (첫 매칭 우선)', () => {
    expect(detectWineType('sparkling rosé')).toBe('sparkling');
  });

  it('"sparkling rose" (accent 없이) → sparkling', () => {
    expect(detectWineType('sparkling rose')).toBe('sparkling');
  });
});

// ---------------------------------------------------------------------------
// 4. 유니코드 경계: 공백 없이 붙은 문자열은 매칭하지 않아야 함
// ---------------------------------------------------------------------------

describe('WINE_TYPE_RULES — 유니코드 경계 (false-positive 방지)', () => {
  it('"redwine" (공백 없음) → 매칭 안 됨', () => {
    expect(detectWineType('redwine')).toBeUndefined();
  });

  it('"whitewine" (공백 없음) → 매칭 안 됨', () => {
    expect(detectWineType('whitewine')).toBeUndefined();
  });

  it('"orangewine" (공백 없음) → 매칭 안 됨', () => {
    expect(detectWineType('orangewine')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 대소문자 무시 (case insensitivity)
// ---------------------------------------------------------------------------

describe('WINE_TYPE_RULES — 대소문자 무시', () => {
  const cases: [string, WineTypeValue][] = [
    ['RED wine', 'red'],
    ['Red Wine', 'red'],
    ['WHITE', 'white'],
    ['Sparkling', 'sparkling'],
    ['ROSÉ', 'rosé'],
    ['Fortified', 'fortified'],
  ];

  it.each(cases)('"%s" → %s', (query, expected) => {
    expect(detectWineType(query)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 6. DETECTION_PATTERNS와 RULES 길이 일치 (구조적 동기화)
// ---------------------------------------------------------------------------

describe('WINE_TYPE_DETECTION_PATTERNS ↔ WINE_TYPE_RULES 동기화', () => {
  it('DETECTION_PATTERNS.length === WINE_TYPE_RULES.length', () => {
    expect(WINE_TYPE_DETECTION_PATTERNS.length).toBe(WINE_TYPE_RULES.length);
  });

  it('WINE_TYPE_RULES는 정확히 8개 와인 타입을 포함', () => {
    expect(WINE_TYPE_RULES.length).toBe(8);
  });

  it('detectsAnyWineType 헬퍼가 DETECTION_PATTERNS와 동일하게 동작', () => {
    expect(detectsAnyWineType('red wine')).toBe(true);
    expect(detectsAnyWineType('randomquery')).toBe(false);
  });
});
