# EPIC-1: Deterministic Core 봉인

> 상태: 계획  
> 의존: 없음 — **모든 EPIC의 선행 조건**  
> 후속: EPIC 2–8 전체 (측정 불가능한 개선은 개선이 아님)

---

## Problem Statement

현재 시스템은 같은 입력·같은 인덱스·같은 모델 버전에서 결과 순서가 흔들릴 수 있는 지점이 다수 존재한다.

### 비결정성 유입 지점 — 현재 코드 상태 직접 확인

| 지점 | 원인 | 현재 코드 상태 |
|------|------|--------------|
| `CandidatePool` 병렬 채널 (`Promise.allSettled`) | settled 배열 순서는 선언 순서로 고정(sparse→learned→dense→anchor)이라 채널 자체는 결정적. **단 각 채널 히트 목록 내부 순서는 Vespa 응답 순서에 의존** | 채널 간 순서: 결정적. 채널 내 히트 순서: **비결정적** |
| `rrfFuse()` — `rrf.ts:48` | `Map<entityId, score>` 반환. 주석에 "sorted by descending score is not guaranteed (caller should sort if needed)" 명시. **호출자가 정렬하지 않으면 Map 삽입 순서에 의존** | 갭 **있음** — 호출자(candidate-pool.ts)가 fuse 후 sort하는지 확인 필요 |
| `Ranker` 정렬 — `ranker.ts:165` | `compareScoredEntriesByFinalScoreDesc`: score desc → entityId asc (2단계). `FINAL_SCORE_SORT_TIE_EPSILON=1e-12` 적용 | **2단계 tie-break 구현됨.** evidence quality, lexical exactness는 없음 |
| Optional learned rerank | `ltrModels?.has(queryClass)` + gate 통과 여부. `RerankDecision` 타입 없음 — 미적용 이유가 코드에 기록 안 됨 | `RerankDecision` 타입 **없음** |
| Browse diversity dedupe — `browse-diversity.ts` | `dedupeSparseHitsByEntity()`: score → rank → entityId 3단계 명시. 주석 "Deterministic tiebreak" 있음 | **결정적. 완료** |
| Agent batch 실행 — `agent-orchestrator.ts:787` | `Promise.allSettled` 결과를 index 기준(`batchResults[bi]`) 처리. 주석 "Promise.all guarantees index alignment" | **결정적. 완료** |
| `stable-comparator.ts` | `compareScoreWithTiebreaker`: score desc → tiebreaker(string) asc 2단계. `pickMaxByScore` 동일 | **2단계. 추가 단계 없음** |

이 상태에서는:
- replay test가 순위 안정성을 검증할 수 없음
- 캐시 키와 실제 결과가 drift할 수 있음
- EPIC 2–8의 모든 개선이 "측정 불가능한 발전"이 됨
- A/B 실험 결과가 노이즈에 묻힘

---

## 목표

```
같은 입력 + 같은 인덱스 + 같은 모델 버전 = 항상 같은 결과
```

모든 ranking/fusion/diversity 단계에 **canonical ordering contract**를 도입한다.

---

## 현재 코드 갭 분석 (코드 직접 확인)

### 이미 결정적인 것 (수정 불필요)

| 항목 | 근거 |
|------|------|
| `CandidatePool` 채널 간 순서 | `Promise.allSettled` 선언 순서(sparse→learned→dense→anchor) 고정 |
| `browse-diversity.ts` dedupe | `score → rank → entityId` 3단계, 주석 "Deterministic tiebreak" 명시 |
| `agent-orchestrator.ts` 배치 | `batchResults[bi]` index 기준, 주석 "Promise.all guarantees index alignment" |
| `Ranker` 기본 정렬 | `compareScoredEntriesByFinalScoreDesc`: `FINAL_SCORE_SORT_TIE_EPSILON=1e-12` + `entityId` 2단계 |

### 실제 갭 — 수정 필요

**갭 1: 각 채널 히트 목록 내부 순서 — Vespa 응답 순서 의존**

`candidate-pool.ts`의 각 채널 task는 `searchIndex.sparseSearch()` / `denseSearch()` 등을 호출하고 결과를 그대로 사용한다. Vespa가 반환한 순서가 그대로 RRF 입력이 된다. Vespa는 score 내림차순을 보장하지만 동점 시 순서는 미보장.

**갭 2: `rrfFuse()` 반환 Map — 후처리 sort 보장 없음**

`rrf.ts:45` 주석: "sorted by descending score is not guaranteed (caller should sort if needed)". `candidate-pool.ts`에서 fuse 후 sort하는지 확인 필요. sort 없으면 Map 삽입 순서(= 첫 등장 채널 순서) 의존.

**갭 3: `Ranker` tie-break — 2단계만 존재**

`ranker.ts:165` `compareScoredEntriesByFinalScoreDesc`: `score → entityId` 2단계. EPIC-1에서 요구하는 `evidence quality → lexical exactness` 중간 단계 없음.

**갭 4: Learned Rerank 미적용 이유 — 기록 없음**

`shouldApplyLearnedRerank` boolean만 있고, 왜 미적용인지(`no_ltr_model_for_query_class` / `gate_rejected` / `feature_dimension_mismatch` / `degraded_fallback`) 기록이 없음. `RerankDecision` 타입 없음.

**갭 5: `determinism_fingerprint` — 부분 substrate는 있으나 입력 계약과 runtime wiring이 미완**

- `src/domain/shared/utils/determinism-fingerprint.ts` 유틸은 이미 존재
- `SearchResponse.meta.determinism_fingerprint` 스키마 필드도 이미 존재
- 다만 현재 입력 계약이 `planner/model/fusion/ranking` 수준에 머물고 `DecisionSnapshot.index_versions` / `response_contract_version` / `feature_flags`를 주 입력으로 삼지 않는다
- `ResponseBuilder` runtime path에서도 fingerprint가 항상 populate된다고 보기 어렵다

### 이미 있는 재활용 substrate

- `stable-comparator.ts`가 stable tiebreak helper를 이미 제공
- `decision_snapshot`이 replay 비교의 기준으로 이미 존재
- `response_hash`가 실제 응답 결과 지문 역할을 이미 수행
- `deterministicHash()` 유틸이 이미 `authority_trace`, `snapshot_id`, `response_hash` 계산에 쓰인다

즉 EPIC-1은 deterministic substrate가 전무한 상태가 아니라,
**정렬 contract 보강 + rerank skip 이유 기록 + fingerprint layering 추가**가 핵심이다.

---

## 설계

### 1. 각 채널 히트 canonicalize (갭 1)

```typescript
// candidate-pool.ts 내 각 채널 task 반환 직후 적용
// src/domain/retrieval/service/candidate-pool.ts

function canonicalizeHits<T extends { score: number; entityId: string }>(hits: T[]): T[] {
  return [...hits].sort((a, b) =>
    (Number.isFinite(b.score) ? b.score : -Infinity) -
    (Number.isFinite(a.score) ? a.score : -Infinity) ||
    a.entityId.localeCompare(b.entityId)   // entityId asc (최종 tie-break)
  )
}
// 각 채널 task 내: return { hits: canonicalizeHits(rawHits), degraded, degradation }
```

> **주의:** evidence quality / lexical exactness는 채널 히트 단계에서는 의미 없음 — 이 단계는 단순 Vespa raw hits. 4단계 tie-break는 Ranker 정렬에만 적용.

### 2. RRF fuse 후 sort 보장 (갭 2)

`rrfFuse()`는 `Map<entityId, score>`를 반환하는 순수 함수이므로 수정하지 않는다 (SSoT 원칙).  
`candidate-pool.ts`에서 fuse 결과를 사용할 때 **반드시 score 내림차순 + entityId asc로 sort** 후 사용:

```typescript
// candidate-pool.ts — fuse 직후
const fusedMap = fusionService.fuse(...)
const fusedSorted = [...fusedMap.entries()]
  .sort(([idA, sA], [idB, sB]) =>
    (sB - sA) || idA.localeCompare(idB)
  )
  .map(([entityId, score]) => ({ entityId, score }))
```

### 3. Ranker tie-break 확장 (갭 3)

`ranker.ts:165` `compareScoredEntriesByFinalScoreDesc` 수정:

```typescript
// 현재: score → entityId (2단계)
// 변경: score → channelMatchType(evidence quality) → bm25Score → entityId (4단계)

const EVIDENCE_QUALITY_RANK: Record<string, number> = {
  exact: 0, alias_exact: 1, alias_fuzzy: 2, semantic: 3, hybrid: 4,
}

function compareScoredEntriesByFinalScoreDesc(a: ScoredEntry, b: ScoredEntry): number {
  // 1. finalScore desc (FINAL_SCORE_SORT_TIE_EPSILON 적용)
  const scoreDiff = ...  // 기존 로직 유지
  if (Math.abs(scoreDiff) > FINAL_SCORE_SORT_TIE_EPSILON) return scoreDiff > 0 ? 1 : -1

  // 2. evidence quality asc (exact이 더 좋음)
  const aQuality = EVIDENCE_QUALITY_RANK[a.channelMatchType ?? 'hybrid'] ?? 4
  const bQuality = EVIDENCE_QUALITY_RANK[b.channelMatchType ?? 'hybrid'] ?? 4
  if (aQuality !== bQuality) return aQuality - bQuality

  // 3. BM25 score desc (lexical exactness)
  const aBm25 = a.componentScores?.lexical ?? 0
  const bBm25 = b.componentScores?.lexical ?? 0
  if (Math.abs(bBm25 - aBm25) > 1e-12) return bBm25 - aBm25

  // 4. entityId asc (최종)
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
}
```

### 4. RerankDecision 타입 추가 (갭 4)

```typescript
// src/domain/ranking/model/rerank-decision.ts (신규)

type RerankSkipReason =
  | 'no_ltr_model_for_query_class'
  | 'gate_rejected'
  | 'safety_envelope_blocked'      // EPIC-5 연계
  | 'feature_dimension_mismatch'
  | 'model_stale'                  // trainedAt 만료
  | 'degraded_fallback'

interface RerankDecision {
  applied: boolean
  modelId?: string
  queryClass: string
  skipReason?: RerankSkipReason
  gateDecision?: RerankGateDecision
}
```

`ranker.ts`의 `applyLearnedLtrRerank()` 반환값에 포함 → `RankingOutput.metadata.rerankDecision` 추가.

### 5. Determinism Fingerprint (갭 5, EPIC-8 Phase 1 공유)

```typescript
// src/domain/shared/utils/determinism-fingerprint.ts (기존 유틸 입력 계약 확장)
// 또는 기존 deterministicHash() wrapper

export function buildDeterminismFingerprint(params: {
  decisionSnapshot: DecisionSnapshot
  fusionConfigHash: string   // JSON.stringify(PER_CLASS_FUSION 설정) SHA256
  rankingConfigHash: string  // JSON.stringify(ScoringWeights) SHA256
  rerankApplied: boolean
  rerankModelId?: string
}): string {
  return deterministicHash({
    plannerVersion: params.decisionSnapshot.planner_version,
    policyRuleVersion: params.decisionSnapshot.policy_rule_version,
    thresholdProfileId: params.decisionSnapshot.threshold_profile_id,
    responseContractVersion: params.decisionSnapshot.response_contract_version,
    modelVersions: params.decisionSnapshot.model_versions,
    indexVersions: params.decisionSnapshot.index_versions,
    featureFlags: params.decisionSnapshot.feature_flags,
    fusionConfigHash: params.fusionConfigHash,
    rankingConfigHash: params.rankingConfigHash,
    rerankApplied: params.rerankApplied,
    rerankModelId: params.rerankModelId ?? null,
  }).slice(0, 16)
}
```

`SearchResponse.meta.determinism_fingerprint`에 항상 포함.

`response_hash`와 역할은 분리한다:

- `response_hash` = 응답 payload 지문
- `determinism_fingerprint` = 실행 contract / config / model / index 지문

---

## Replay Suite

```typescript
// test/regression/determinism.regression.test.ts (append-only)

describe('Deterministic Core — 1000 replay', () => {
  const REPLAY_COUNT = 1000
  const TEST_QUERIES = [
    '묵직한 보르도 레드',
    'Château Margaux',
    '달달한 화이트 5만원 이하',
    '연어에 어울리는 와인',
    // ... 대표 쿼리 세트
  ]

  for (const query of TEST_QUERIES) {
    it(`순위 bit-stable: "${query}"`, async () => {
      const results = await Promise.all(
        Array.from({ length: REPLAY_COUNT }, () => executeSearch(query))
      )
      const first = results[0].map(r => r.entityId)
      for (const result of results.slice(1)) {
        expect(result.map(r => r.entityId)).toEqual(first)
      }
    })

    it(`fingerprint stable: "${query}"`, async () => {
      const fps = await Promise.all(
        Array.from({ length: REPLAY_COUNT }, () =>
          executeSearch(query).then(r => r.meta.determinism_fingerprint)
        )
      )
      expect(new Set(fps).size).toBe(1)
    })
  }
})

describe('Degradation 상태에서도 순위 안정', () => {
  it('dense 채널 비활성 — sparse-only 순위 stable', ...)
  it('anchor 채널 비활성 — 2채널 RRF 순위 stable', ...)
  it('learned rerank skip — heuristic 순위 stable', ...)
})
```

---

## 완료 조건

- replay suite에서 동일 요청 1,000회 재실행 → 순위와 explanation이 **bit-stable**
- 캐시 키와 실제 결과가 drift 없이 일치
- rerank on/off, dense fail, sparse fail 각 degradation 상태에서도 순위 안정적
- `RerankDecision.skipReason`이 모든 미적용 케이스에서 명시됨
- `determinism_fingerprint`가 동일 입력에서 항상 같은 값
- `response_hash`와 `determinism_fingerprint`가 서로 다른 층위의 지문으로 문서화됨

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/shared/utils/rrf.ts` | 입력 canonicalize 후 fuse |
| `src/domain/shared/utils/stable-comparator.ts` | 4단계 tie-break 명시 (SSoT) |
| `src/domain/retrieval/service/candidate-pool.ts` | 채널별 결과 canonicalize |
| `src/domain/retrieval/service/browse-diversity.ts` | dedupe tie-break 명시 |
| `src/domain/ranking/service/ranker.ts` | tie-break 4단계 적용, RerankDecision 생성 |
| `src/domain/ranking/model/rerank-decision.ts` | **신규** RerankDecision 타입 |
| `src/application/agent/agent-orchestrator.ts` | 병렬 도구 결과 정렬 |
| `src/domain/shared/utils/determinism-fingerprint.ts` | 기존 유틸 입력 계약 확장 |
| `src/interface/http/schemas/search-response.schema.ts` | 기존 `meta.determinism_fingerprint` 필드 유지 |
| `src/domain/response/service/response-builder.ts` | fingerprint runtime projection 추가 / 안정화 |
| `test/regression/determinism.regression.test.ts` | **신규** replay suite (append-only) |
