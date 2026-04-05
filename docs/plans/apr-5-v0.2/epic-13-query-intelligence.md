# Epic 13: Query Intelligence — Contradiction, Abstain, Typo+Phonetic

**Phase:** 4
**의존성:** v0.1 Epic 3 (eval pipeline), Epic 12 (food pairing data for eval)
**해소 갭:** Conflicting constraints (3), Generic name abstain (5), Typo + phonetic combined (7)

---

## 목표

쿼리 이해 계층을 SOTA++ 수준으로 끌어올린다.
세 갭은 독립적이지만 모두 `planner.ts` 직후 레이어에서 해결된다.

---

## Step 13.1 — ConstraintSAT: 논리적 모순 선탐지

### 문제

"dry sweet wine", "under 10000 won over 50000 won" 같이 하드 제약이 서로 논리적으로 모순될 때
현재 시스템은 0개 결과를 반환하거나 한 쪽 제약을 조용히 무시한다.
RFC-006 §4.2는 contradiction을 early-exit 해야 한다고 명시한다.

### 실제 타입 확인

실제 코드베이스의 constraint 타입:
```typescript
// src/domain/shared/types/constraint-bundle.ts
export type ConstraintOperator = '=' | '<=' | '>=' | 'range' | 'in' | 'exclude';

export interface NormalizedConstraint {
  readonly attribute: string;
  readonly operator: ConstraintOperator;
  readonly value: string | number | { min: number; max: number } | ReadonlyArray<string>;
  readonly source_phrase: string;
  readonly confidence: number;
}
```

### 접근법: Constraint SAT Layer

```typescript
// src/domain/query/service/constraint-sat.ts

import type { NormalizedConstraint, ConstraintBundle } from '../../shared/types/index.js';

export type ContradictionResult =
  | { contradicted: false }
  | {
      contradicted: true;
      conflictPairs: Array<[NormalizedConstraint, NormalizedConstraint]>;
    };

/**
 * RFC-006 §4.2 — detects logical contradictions among hard constraints
 * before retrieval begins. O(n²) over hard constraints (n ≤ 20 in practice).
 */
export class ConstraintSAT {
  check(constraints: ConstraintBundle): ContradictionResult {
    const hard = constraints.hard;
    const conflicts: Array<[NormalizedConstraint, NormalizedConstraint]> = [];

    for (let i = 0; i < hard.length; i++) {
      for (let j = i + 1; j < hard.length; j++) {
        if (this.contradicts(hard[i]!, hard[j]!)) {
          conflicts.push([hard[i]!, hard[j]!]);
        }
      }
    }

    if (conflicts.length === 0) return { contradicted: false };
    return { contradicted: true, conflictPairs: conflicts };
  }

  private contradicts(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.attribute !== b.attribute) return false;
    return (
      this.rangesDisjoint(a, b) ||
      this.enumValuesDisjoint(a, b) ||
      this.booleanOpposite(a, b)
    );
  }

  /**
   * Detects disjoint numeric ranges using actual ConstraintOperator values.
   * ConstraintOperator = '=' | '<=' | '>=' | 'range' | 'in' | 'exclude'
   *
   * Contradiction cases:
   *   a <= X, b >= Y  where X < Y  (e.g. price <= 10000 AND price >= 50000)
   *   a >= X, b <= Y  where X > Y  (same condition, reversed)
   *   a.range = {min:X,max:Y}, b >= Z where Z > Y
   */
  private rangesDisjoint(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.operator === '<=' && b.operator === '>=') {
      return Number(a.value) < Number(b.value);
    }
    if (a.operator === '>=' && b.operator === '<=') {
      return Number(a.value) > Number(b.value);
    }
    if (a.operator === 'range' && b.operator === '>=') {
      const range = a.value as { min: number; max: number };
      return Number(b.value) > range.max;
    }
    if (a.operator === 'range' && b.operator === '<=') {
      const range = a.value as { min: number; max: number };
      return Number(b.value) < range.min;
    }
    return false;
  }

  private enumValuesDisjoint(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    // Both must be '=' (single-value equality) on the same attribute
    if (a.operator !== '=' || b.operator !== '=') return false;
    const MUTUALLY_EXCLUSIVE: Record<string, string[][]> = {
      sweetness: [['dry', 'brut'], ['sweet', 'demi-sec', 'doux', 'dolce']],
      color: [['red'], ['white'], ['rosé', 'rose']],
    };
    const groups = MUTUALLY_EXCLUSIVE[a.attribute];
    if (!groups) return false;
    const aGroup = groups.findIndex((g) => g.includes(String(a.value)));
    const bGroup = groups.findIndex((g) => g.includes(String(b.value)));
    return aGroup !== -1 && bGroup !== -1 && aGroup !== bGroup;
  }

  private booleanOpposite(a: NormalizedConstraint, b: NormalizedConstraint): boolean {
    if (a.operator !== '=' || b.operator !== '=') return false;
    return (
      (a.value === true && b.value === false) ||
      (a.value === false && b.value === true)
    );
  }
}
```

### SearchUseCase 통합

ConstraintSAT 체크는 **Planner 이후, retrieval 이전**에 SearchUseCase에서 실행한다.
Planner는 immutable `QueryPlanV1`을 반환하므로 planner 내부에서 early exit하지 않는다.

```typescript
// src/application/search/search.usecase.ts — execute() 내

const plan = await this.deps.queryPlanner.plan(request.query, plannerContext);

// Contradiction check: before any retrieval
const satResult = this.constraintSAT.check(plan.constraints);
if (satResult.contradicted) {
  return this.deps.responseBuilder.buildContradiction({
    queryPlan: plan,
    conflictPairs: satResult.conflictPairs,
    requestId,
    queryTimeMs: Date.now() - startTime,
  });
}
```

`SearchUseCaseDeps`에 `constraintSAT: ConstraintSAT` 추가.

### Contradiction Response

`ResponseBuilder.buildContradiction()` 추가 — `EngineDecision.decisionStatus = 'failed'`,
`EngineDecision.failureReason = 'HARD_CONSTRAINT_VIOLATION'` (기존 FailureReason 사용).
Response body에 `violatedConstraints` 배열 노출.

```json
{
  "engine_decision": {
    "decision_status": "failed",
    "failure_reason": "HARD_CONSTRAINT_VIOLATION",
    "violated_constraints": [
      { "attribute": "sweetness", "values": ["dry", "sweet"], "source_phrases": ["dry", "sweet"] }
    ]
  },
  "results": []
}
```

### 검증

| 쿼리 | 기대 결과 |
|------|----------|
| "dry sweet wine" | `contradicted: true`, attribute=sweetness |
| "under 10000 over 50000" | `contradicted: true`, attribute=price (price <= 10000 AND price >= 50000) |
| "red rosé wine" | `contradicted: true`, attribute=color |
| "tannic light body" | `contradicted: false` (soft heuristic만) |

---

## Step 13.2 — Calibrated Entropy Abstain

### 문제

"마고" (Margaux) — 와이너리일 수도, 특정 빈티지일 수도, 여러 앙팡질 와인일 수도.
현재: 임의로 상위 결과 반환. SOTA: top-K 점수 분산을 entropy로 정량화하고
임계값 이상이면 clarification을 요청.

### 통합 위치: SearchUseCase, 랭킹 후

Entropy는 retrieval 점수가 있어야 계산 가능하다. Planner가 아닌
**SearchUseCase에서 RankedResult를 받은 직후** 호출한다.

```typescript
// src/application/search/search.usecase.ts — executeHybridRoute() 반환 후

const topScores = rankedResults.slice(0, 10).map((r) => r.finalScore);
const abstainDecision = this.abstainPolicy.shouldAbstain(topScores);

if (abstainDecision.abstain) {
  return this.deps.responseBuilder.buildClarification({
    queryPlan: plan,
    entropy: abstainDecision.entropy,
    requestId,
    queryTimeMs: Date.now() - startTime,
  });
}
```

### 구현

```typescript
// src/domain/query/service/abstain-policy.ts

/**
 * RFC-013 §3 — Calibrated entropy abstain.
 * Computes normalized Shannon entropy over top-K retrieval scores.
 * If entropy exceeds threshold, the engine abstains and requests clarification.
 */
export class AbstainPolicy {
  /**
   * @param entropyThreshold  Calibrated on dev set via Youden's J; default 0.82
   * @param minCandidates     Minimum candidates required to compute entropy
   */
  constructor(
    private readonly entropyThreshold: number = 0.82,
    private readonly minCandidates: number = 3,
  ) {}

  shouldAbstain(scores: readonly number[]): AbstainDecision {
    if (scores.length < this.minCandidates) {
      return { abstain: false };
    }
    const entropy = this.normalizedEntropy(scores);
    if (entropy >= this.entropyThreshold) {
      return { abstain: true, entropy };
    }
    return { abstain: false, entropy };
  }

  private normalizedEntropy(scores: readonly number[]): number {
    const maxScore = Math.max(...scores);
    const expScores = scores.map((s) => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    const probs = expScores.map((e) => e / sumExp);
    const rawEntropy = probs.reduce((h, p) => (p <= 0 ? h : h - p * Math.log2(p)), 0);
    const maxEntropy = Math.log2(scores.length);
    return maxEntropy > 0 ? rawEntropy / maxEntropy : 0;
  }
}

type AbstainDecision =
  | { abstain: false; entropy?: number }
  | { abstain: true; entropy: number };
```

### 임계값 보정

```typescript
// scripts/calibrate-abstain-threshold.ts
// 1. dev set: "ambiguous" 레이블 쿼리 100개 + "unambiguous" 100개
// 2. 각 쿼리 top-10 점수 → normalizedEntropy()
// 3. Youden's J = sensitivity + specificity - 1 최대화 지점 탐색
// 목표: ambiguous abstain rate ≥ 0.90, false abstain rate ≤ 0.05
```

### Clarification Response

`ResponseBuilder.buildClarification()`은 이미 `ClarificationPayload` 타입을 통해
기존 `SearchResponseV1` 구조 내에서 동작한다:

```json
{
  "engine_decision": { "decision_status": "ambiguous", "next_action": "clarify" },
  "clarification": {
    "prompt": "여러 해석이 가능합니다. 어떤 것을 찾으시나요?",
    "options": ["Château Margaux (생산자)", "Margaux AOC (지역)", "앙팡질 뒤 샤토 마고"]
  },
  "results": []
}
```

---

## Step 13.3 — BK-tree + Soundex: Typo × Phonetic Combined

### 문제

현재: alias 테이블로 "까베르네" → "Cabernet Sauvignon" 커버.
"카베르네 소비뇽" (오타) 또는 "Cabarnet" (영문 오타) → alias miss.

### 접근법: 이중 인덱스 교차 점수

```typescript
// src/domain/query/service/fuzzy-matcher.ts

export class FuzzyMatcher {
  private bkTreeEn!: BKTree;
  private bkTreeKo!: BKTree;

  async initialize(aliasStore: AliasStore): Promise<void> {
    const allTerms = await aliasStore.getAllTerms();
    this.bkTreeEn = BKTree.build(
      allTerms.filter((t) => /[a-z]/i.test(t)),
      levenshteinDistance,
    );
    this.bkTreeKo = BKTree.build(
      allTerms.filter((t) => /[가-힣]/.test(t)),
      levenshteinDistance,
    );
  }

  match(query: string, maxEditDistance: number = 2): FuzzyMatchResult[] {
    const isKorean = /[가-힣]/.test(query);
    const bkTree = isKorean ? this.bkTreeKo : this.bkTreeEn;
    const phoneticFn = isKorean ? soundexKo : soundexEn;

    const editCandidates = bkTree.search(query, maxEditDistance);
    const queryPhonetic = phoneticFn(query);

    return editCandidates
      .map((c) => {
        const phoneticSim = phoneticFn(c.term) === queryPhonetic ? 1.0 : 0.0;
        const editSim = 1 - c.distance / Math.max(query.length, c.term.length);
        const combinedScore = 0.6 * editSim + 0.4 * phoneticSim;
        return { term: c.term, editDistance: c.distance, phoneticSim, combinedScore };
      })
      .filter((r) => r.combinedScore >= 0.5)
      .sort((a, b) => b.combinedScore - a.combinedScore);
  }
}

type FuzzyMatchResult = {
  term: string;
  editDistance: number;
  phoneticSim: number;   // 0.0 or 1.0
  combinedScore: number;
};
```

### BK-tree

```typescript
// src/domain/query/service/bk-tree.ts

export class BKTree {
  private constructor(private readonly root: BKNode) {}

  static build(terms: string[], distFn: (a: string, b: string) => number): BKTree {
    if (terms.length === 0) return new BKTree({ term: '', children: new Map(), distFn });
    const root: BKNode = { term: terms[0]!, children: new Map(), distFn };
    for (const term of terms.slice(1)) BKTree.insert(root, term, distFn);
    return new BKTree(root);
  }

  search(query: string, maxDistance: number): Array<{ term: string; distance: number }> {
    const results: Array<{ term: string; distance: number }> = [];
    BKTree.searchNode(this.root, query, maxDistance, results);
    return results;
  }

  // BK-tree invariant: node's children keyed by d(parent, child)
  private static insert(node: BKNode, term: string, distFn: (a: string, b: string) => number): void {
    const d = distFn(node.term, term);
    if (node.children.has(d)) {
      BKTree.insert(node.children.get(d)!, term, distFn);
    } else {
      node.children.set(d, { term, children: new Map(), distFn });
    }
  }

  private static searchNode(
    node: BKNode,
    query: string,
    max: number,
    out: Array<{ term: string; distance: number }>,
  ): void {
    const d = node.distFn(node.term, query);
    if (d <= max) out.push({ term: node.term, distance: d });
    for (const [k, child] of node.children) {
      if (k >= d - max && k <= d + max) BKTree.searchNode(child, query, max, out);
    }
  }
}

interface BKNode {
  term: string;
  children: Map<number, BKNode>;
  distFn: (a: string, b: string) => number;
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = a[i-1] === b[j-1]
        ? dp[i-1]![j-1]!
        : 1 + Math.min(dp[i-1]![j]!, dp[i]![j-1]!, dp[i-1]![j-1]!);
  return dp[m]![n]!;
}
```

### 한국어 Soundex

```typescript
// src/domain/query/service/phonetic.ts

// 한국어: 초성 phonetic code
const KO_PHONETIC: Record<string, string> = {
  'ㄱ':'G','ㄲ':'G','ㄴ':'N','ㄷ':'D','ㄸ':'D','ㄹ':'L',
  'ㅁ':'M','ㅂ':'B','ㅃ':'B','ㅅ':'S','ㅆ':'S','ㅈ':'J',
  'ㅉ':'J','ㅊ':'C','ㅋ':'K','ㅌ':'T','ㅍ':'P','ㅎ':'H','ㅇ':'',
};

export function soundexKo(s: string): string {
  return s
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0xAC00 && code <= 0xD7A3) {
        // 한글 음절 → 초성 추출
        const jamo = String.fromCharCode(0x1100 + Math.floor((code - 0xAC00) / 588));
        return KO_PHONETIC[jamo] ?? '';
      }
      return '';
    })
    .join('');
}

export function soundexEn(s: string): string {
  const upper = s.toUpperCase();
  const codes: Record<string, string> = {
    BFPV: '1', CGJKQSXYZ: '2', DT: '3', L: '4', MN: '5', R: '6',
  };
  let result = upper[0] ?? '';
  let prev = '';
  for (const ch of upper.slice(1)) {
    const code = Object.entries(codes).find(([k]) => k.includes(ch))?.[1] ?? '';
    if (code && code !== prev) result += code;
    prev = code;
    if (result.length === 4) break;
  }
  return result.padEnd(4, '0');
}
```

### Planner 통합 위치

`NLMapper` → 토큰 추출 후, alias 조회 실패 시 `FuzzyMatcher.match()` 호출.
결과를 `expansions.lexical`에 추가하고 `expansion_source: 'fuzzy'` 태그.
FuzzyMatcher는 startup 시 `initialize(aliasStore)` 호출 (BK-tree 빌드 1회).

### 성능 목표

| 지표 | 목표 |
|------|------|
| BK-tree 빌드 시간 (10K terms) | ≤ 200ms (startup 1회) |
| 쿼리 처리 latency 추가 | ≤ 5ms p99 |
| Typo Recall@10 | ≥ 0.70 (alias-only 대비 +15%) |

---

## Completion Criteria

- [ ] "dry sweet wine" → `HARD_CONSTRAINT_VIOLATION` 응답, `decision_status: 'failed'`, `results: []`
- [ ] "under 10000 over 50000" → contradiction 감지 (`price <= 10000` AND `price >= 50000`)
- [ ] "마고" → entropy ≥ threshold → `decision_status: 'ambiguous'`, `next_action: 'clarify'`
- [ ] abstain threshold 보정: ambiguous abstain rate ≥ 0.90 on dev set
- [ ] "Cabarnet Sauvignon" → BK-tree + Soundex → Cabernet Sauvignon recall
- [ ] "카베르네 소비뇽" → BK-tree → Cabernet Sauvignon alias match
- [ ] Typo Recall@10 ≥ 0.70 on golden query set typo slice
