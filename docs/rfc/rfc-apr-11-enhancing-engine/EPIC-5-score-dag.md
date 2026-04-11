# EPIC-5: Ranker Score DAG + Rerank Safety Envelope

> 상태: 계획  
> 의존: EPIC-4 (retrieval evidence detail / CandidateProvenance 확장 → signal input)  
> 후속: EPIC-6 (abstain 판단 개선), EPIC-8 (ranking_delta_trace, rerank_decision_trace)  
> **rerank safety envelope는 현재 코드에 invariant 갭 — EPIC-2와 병렬로 착수**

---

## 현재 문제

- `finalScore`가 단일 숫자 — "왜 1등인지" 역추적하려면 `componentScores` / response의 `score_components`를 봐야 하지만 rerank 전후 normalized delta까지는 재현 불가
- Learned LTR reranker가 hard constraint 위반 후보를 올릴 수 없다는 보장이 코드에 없음 (**버그 수준 갭**)
- rerank로 순위가 얼마나 뒤집혔는지 배포 단위 모니터링 불가
- Score monotonicity 테스트 없음 — signal 값이 올라가도 finalScore가 내려갈 수 있음

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `componentScores` | `ranked-result.ts` | 이미 존재. response에는 일부 projection만 노출 |
| `retrievalProvenance` | `ranked-result.ts` | 이미 존재. score provenance와 retrieval provenance 연결점 역할 |
| `ScoreDecomposition` | — | **없음** |
| `rerankDelta` | — | **없음** — rerank 전후 순위 변화 기록 없음 |
| Rerank Safety Envelope | — | **없음** — LTR이 hard constraint 위반 후보를 올릴 수 있는 invariant 갭 존재 |
| `RerankDecision` | — | **없음** (EPIC-1과 공유) |
| `applyLearnedLtrRerank()` | `ranker.ts:180` | 실행은 됨. 실패 시 `skippedDueToDimensionMismatch` boolean만 반환 — 이유 상세 없음 |
| Score monotonicity test | — | **없음** |

**핵심 갭 (버그 수준):** Rerank Safety Envelope가 없어서 LTR이 `wine_type='red'` 쿼리에서 white wine 후보를 1위로 올려도 막을 방법이 없음.  
`ScoreDecomposition`은 없고 기존 `componentScores`/`score_components`만으로는 rerank 전후 normalized contract를 재현할 수 없다.

---

## 목표

`finalScore`를 단일 숫자에서 **Score DAG**로 확장하고,  
reranker가 hard constraint invariants를 깰 수 없는 **Safety Envelope**를 추가한다.

---

## 설계 전제 (현재 코드 계약을 SSOT로 채택)

- 현재 aggregate score와 LambdaMART inference score는 모두 **`[0,1] bounded score`** 계약이다
- raw heuristic 합산값은 디버깅/분해용으로는 유용하지만, **query class 간 직접 비교나 safety rule의 주 계약으로 쓰면 안 된다**
- Safety Envelope는 "점수 절대값 비교"보다 **순위 보존 / protected candidate 보존 / constraint monotonicity 보존**에 초점을 둔다
- 따라서 EPIC-5는 raw heuristic ratio 기반 차단 규칙을 도입하지 않고, **normalized score + rank invariant**를 단일 계약으로 채택한다

### 비목표

- `heuristicScoreRaw`만으로 candidate safety를 판정하지 않는다
- query class마다 다른 scale을 가지는 raw score에 단일 임계값을 적용하지 않는다
- reranker score 하나만으로 heuristic ordering 전체를 무제한 뒤집게 하지 않는다

---

## 설계

### ScoreDecomposition (기존 RankedResult 확장)

```typescript
interface ScoreDecomposition {
  // 1차 신호 (heuristic ranker 산출)
  lexicalContribution: number          // BM25 × sparseWeight
  semanticContribution: number         // cosine × denseWeight
  anchorContribution: number           // anchor similarity × anchorWeight
  attributeSatisfaction: number        // constraint match score
  popularityContribution: number       // popularity × weight
  preferenceAlignmentContribution: number

  // 집계
  heuristicScoreRaw: number            // 위 합산 (diagnostic only; query-class 간 직접 비교 금지)
  heuristicScoreNormalized: number     // 현재 ranker 계약과 같은 [0, 1] bounded score

  // 재랭킹 델타 (LTR 적용 시)
  rerankDeltaNormalized?: number       // ltrScoreNormalized - heuristicScoreNormalized
  ltrScoreNormalized?: number
  ltrFeatureVector?: number[]          // 8차원 (LAMBDAMART_FEATURE_DIMENSION)

  // 최종
  finalScore: number
}
```

`ScoreDecomposition`은 기존 `componentScores`를 대체하는 새 truth가 아니라,
기존 `RankedResult` 위에 추가되는 **rerank-aware normalized layer**다.

즉:

- `componentScores`는 유지
- `ScoreDecomposition`은 `componentScores`를 참조해 계산
- response projection은 migration 기간 동안 `score_components`와 공존 가능

### Rerank Safety Envelope

```typescript
interface RerankSafetyResult {
  allowed: boolean
  blockedReason?: 'hard_constraint_violation' | 'normalized_score_collapse' | 'rank_invariant_breach'
  constraintViolations?: string[]   // 어떤 hard constraint를 위반했는지
  metrics?: {
    heuristicScoreNormalized?: number
    ltrScoreNormalized?: number
    preRerankRank?: number
    postRerankRank?: number
    preRerankTop1Gap?: number
    postRerankTop1Gap?: number
  }
}

function evaluateRerankSafety(
  candidate: RankedResult,
  hardConstraints: ConstraintAtom[],
  heuristicRank: number,
  proposedLtrRank: number,
): RerankSafetyResult
```

**Safety Envelope 규칙:**
1. **Hard constraint 위반 후보는 rerank로 올릴 수 없음** — `wine_type`, `region`, `vintage_year` 등 hard attribute를 위반한 후보는 heuristic 순위 이하로만 유지 가능
2. **Normalized score collapse 방지** — 현재 ranker/LTR 계약은 `[0,1]` bounded score이므로 raw ratio를 쓰지 않는다. 대신 `ltrScoreNormalized`가 `heuristicScoreNormalized` 대비 비정상적으로 급락하면서 순위가 상승하는 경우 차단한다
3. **Rank invariant 보존** — rerank 후에도 hard-constraint-satisfying 후보가 미충족 후보 아래로 내려가면 차단한다
4. **Known-item / exact-anchor 보호** — exact alias / sparse rank1 / anchor-conditioned 후보가 rerank로 비정상적으로 밀려나는 경우 차단하거나 heuristic 순위를 유지한다

`score_collapse`는 다음과 같은 **rank/normalized invariant**로 정의한다:

- 후보의 `ltrScoreNormalized`가 `heuristicScoreNormalized`보다 큰 폭으로 낮아졌는데도 순위는 상승한 경우
- rerank 후 top-1/top-2 normalized gap이 pre-rerank 대비 급격히 악화된 경우
- exact-anchor evidence 또는 protected recall 후보가 rerank 후 비보호 후보 아래로 내려간 경우

즉 **`ltrScore < heuristicScore × 0.5` 같은 raw heuristic ratio 규칙은 사용하지 않는다.**
현재 코드의 aggregate score와 LambdaMART inference score는 모두 bounded/normalized contract를 가지므로,
Safety Envelope도 동일한 계약 위에서 정의해야 한다.

### Safety Envelope 평가 단위

Safety Envelope는 "후보별 단건 판정"만으로는 부족하므로, 최소 두 레벨로 평가한다:

1. **candidate-level**
   - hard constraint 위반 후보의 상승 차단
   - exact-anchor / protected candidate의 비정상 하락 차단
2. **list-level**
   - pre/post rerank top-K ordering drift 측정
   - pre/post rerank top-1 gap 악화 측정
   - hard-constraint-satisfying candidate set이 미충족 set 아래로 내려가는지 검증

즉 `evaluateRerankSafety()`는 내부적으로 candidate signal을 쓰더라도,
최종 결정은 **candidate-level + list-level invariant**를 모두 본다.

### 임계값 정책

- `normalized_score_collapse` 임계값은 상수 `0.5` 같은 하드코딩 비율로 두지 않는다
- query class별로 calibration이 필요한 값은 **offline eval + shadow run**으로 튜닝한다
- 1차 구현은 절대 임계값보다 **rank-direction invariant**를 우선 적용한다
- 수치 임계값이 필요한 경우에도 기준은 raw score가 아니라
  - normalized delta
  - rank delta
  - top-1/top-2 gap delta
  - protected candidate eviction
  중 하나여야 한다

### ScoreDriftMonitor

배포 단위로 LTR이 heuristic을 얼마나 뒤집는지 추적:

```typescript
interface ScoreDriftRecord {
  queryClass: string
  heuristicTop3EntityIds: string[]
  ltrTop3EntityIds: string[]
  rankOrderChanges: number           // Kendall tau distance
  averageRerankDeltaNormalized: number
  safetyEnvelopeBlocks: number       // 이번 요청에서 차단된 후보 수
}
```

`globalSilentSkipCounter` 또는 별도 metric으로 집계.

`ScoreDriftRecord`는 단순 observability가 아니라 Safety Envelope의 acceptance gate에도 사용한다.
즉 모델 교체/재학습 시:

- `rankOrderChanges` 급증
- `safetyEnvelopeBlocks` 급증
- protected candidate eviction 증가

중 하나라도 baseline 대비 급등하면 promotion을 막는다.

### 삽입 위치

```
Ranker.rank() 내부

  ... (기존 Steps 1–5)
  ↓
  Step 6: 재랭킹 게이트 (기존)
  ↓
  Step 6b: applyLearnedLtrRerank() 호출 전 (신규)
    ↓
    evaluateRerankSafety() — 각 후보에 대해 검사
    → blocked → heuristic 순위 고정 + safetyEnvelopeBlocks++ (신규)
    → allowed → LTR rerank 적용 (기존)
  ↓
  ScoreDecomposition 생성 — 기존 RankedResult에 첨부 (신규)
  ↓
  ScoreDriftMonitor 기록 (신규)
  ↓
  반환: RankingOutput { results, metadata }
```

---

## 완료 조건

- 특정 후보가 rerank로 상승/하락한 이유를 `ScoreDecomposition.rerankDeltaNormalized`로 설명 가능
- hard constraint 위반 후보가 LTR로 올라오는 케이스 → `safetyEnvelopeBlocks` 카운터 증가 + 차단
- `ScoreDriftRecord`를 통해 LTR 모델 버전 단위 score drift 비교 가능
- score monotonicity tests: `attributeSatisfaction`이 오른 후보가 finalScore도 올라야 함
- constraint-sensitive regression test: hard constraint 위반 후보는 항상 최하위
- score collapse regression test: raw heuristic ratio가 아니라 normalized/rank invariant 위반만 차단해야 함
- exact known-item regression test: sparse rank1 / exact alias / anchor-conditioned 후보가 rerank 후 비보호 후보 아래로 밀리지 않아야 함
- query-class portability: 같은 safety rule이 `short_entity`, `ambiguous_short_form`, `semantic_preference`에서 raw scale 차이와 무관하게 동작해야 함

---

## 테스트 계획

```
// 회귀 테스트 1: hard constraint 위반 후보 LTR 차단
input: wine_type='red' 쿼리, LTR이 white wine 후보를 1위로 제안
expected: safety envelope 차단 → white wine 최하위 유지

// 회귀 테스트 2: score monotonicity
input: 동일 쿼리, 후보 A (constraint 모두 충족) vs 후보 B (1개 미충족)
expected: finalScore(A) > finalScore(B) (rerank 후에도)

// 회귀 테스트 3: normalized score collapse 차단
input: 후보 A의 ltrScoreNormalized는 heuristicScoreNormalized보다 급락했지만 rerank 결과 rank는 상승
expected: safety envelope 차단 → heuristic rank 유지

// 회귀 테스트 4: rerankDelta 추적
input: LTR 모델이 heuristic 순위를 뒤집은 케이스
expected: rerankDeltaNormalized != 0, ScoreDriftRecord.rankOrderChanges > 0

// 회귀 테스트 5: protected candidate eviction 차단
input: sparse rank1 + exact alias 후보가 rerank 후 3위로 밀리는 케이스
expected: safety envelope 차단 또는 heuristic ordering 유지
```

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/ranking/service/ranker.ts` | Safety Envelope 삽입, ScoreDecomposition 생성 |
| `src/domain/ranking/model/ranked-result.ts` | `scoreDecomposition?: ScoreDecomposition` 추가 |
| `src/domain/ranking/service/rerank-safety.ts` | **신규** Safety Envelope 로직 |
| `src/domain/ranking/service/score-drift-monitor.ts` | **신규** drift 집계 |
| `src/domain/ranking/model/score-decomposition.ts` | **신규** 타입 정의 |
| `src/observability/silent-skip-counters.ts` | `safetyEnvelopeBlocks` counter 추가 |
| `src/interface/http/schemas/search-response.schema.ts` | `score_components` projection 확장 |
