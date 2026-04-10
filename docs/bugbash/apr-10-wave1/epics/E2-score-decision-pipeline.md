# E2 — Score & Decision Pipeline

**목표**: 83% ambiguous 현상 해소 + NDCG 복구. entropy abstain, conformal calibration, LTR 파이프라인을 구조적으로 수리한다.
**영향**: 현재 eval NDCG@10 = 0.105 (baseline 0.390 대비 -73%). 83% 쿼리가 응답 없이 돌아옴.
**SOTA++ 방향**: "patch threshold" 아님. LTR 없을 때 abstain gate를 mathematically bypass하고, calibration 파이프라인을 end-to-end로 연결. LTR 모델 학습까지 완주.

---

## 버그 목록

| ID | 심각도 | 제목 | 파일 |
|----|--------|------|------|
| RCA-01 | 🔴 P0 | entropy abstain gate — heuristic 환경에서 수학적으로 항상 발동 | `abstain-policy.ts` |
| RCA-02 | 🔴 P0 | NDCG@10 0.105 — RCA-01의 downstream 결과 | — |
| RCA-04 | 🟠 P1 | conformal alpha 불일치 (0.3 vs 0.1) + DB 비어있어 identity fallback | `resolver.ts`, `run-offline-eval.ts` |
| RCA-05 | 🟡 P2 | LTR 모델 미학습 — heuristic weights fallback 중 | `lambdamart-ranker.ts` |
| BUG-07 | 🟡 P2 | LTR 26-feature dead code — train-serve skew 위험 | `ltr-features.ts` |
| BUG-08 | 🟡 P2 | `rerank_score` LTR feature 누락 | `ltr-feature-extractor.ts` |
| BUG-12 | 🟠 P1 | `feature-parity-hash.ts` production 미연결 | `feature-parity-hash.ts` |
| BUG-13 | 🟠 P1 | `extractExtendedLTRFeatures()` 테스트 전무 | `ltr-feature-extractor.test.ts` |
| BUG-09 | 🔵 P3 | 예산 제약 soft 분류 — hard filter로 변경 검토 | `rule-based-constraint-extractor.ts` |
| W2-BUG-09 | 🟠 P1 | alpha 상수 SSoT 위반 | `conformal-config.ts` (신규) |
| W2-BUG-10 | 🟠 P1 | 피드백 → calibration 파이프라인 미연결 | 신규 job |
| W2-BUG-12 | 🟡 P2 | explanation이 제약 조건과 ungrounded | `human-response-builder-v2.ts` |
| RCA5-01 | 🔴 P0 | Abstain gate 수학적 불가능성 (이미 RCA-01과 동일) | — |
| SCAN4-10 | 🟠 P1 | LTR 모델 가중치 DB 로드 후 검증 없음 — NaN/Infinity weight로 학습 모델 로드 가능 | `lambdamart-ranker.ts` |
| SCAN4-11 | 🟡 P2 | `finalScore` re-clamp 누락 — weighted sum이 [0,1] 초과 가능 | `lambdamart-ranker.ts` |
| SCAN4-12 | 🟡 P2 | default weights 합산 0.95 — `MAX_SCORE` 구조적으로 미도달 | `lambdamart-ranker.ts` |
| RCA-05 | 🟡 P2 | LTR 모델 미학습 — heuristic weights fallback 중 (graceful하지만 NDCG 저하 원인) | `lambdamart-ranker.ts` |
| RCA-06 | 🟡 P2 | eval 코퍼스 파일 경로 불일치 — `/tmp/test300-v3.ndjson` 없음, `pilot200-*.ndjson`과 혼재 | eval harness |
| W2-06 | 🔵 P3 | `lambdamart-ranker.ts:216` `featureNames[0]` 폴백 — 인덱스 버그 시 오류 대신 잘못된 feature 사용 | `lambdamart-ranker.ts:216` |

---

## RCA 요약

### RCA-01: entropy abstain — threshold 올리는 것은 해결책이 아님

**수학적 증명**:
- heuristic score 분포: [0.2, 0.6] tight cluster
- softmax는 작은 차이를 평탄하게 만듦: exp(-0.01) ≈ 0.99
- 전형적 10-candidate entropy: **0.9993** (uniform = 1.0)
- threshold 0.95로 올려도 abstain율 ~80% 유지

**근본 원인**: entropy gate는 LTR logit score (넓은 분포) 전제. heuristic linear sum은 [0,1] clamped → 항상 tight cluster → 항상 고entropy.

**올바른 fix**: threshold 조정이 아니라 **LTR 없을 때 gate bypass**.

### SCAN4-10: LTR 가중치 DB 로드 후 검증 없음

`lambdamart-ranker.ts`: DB에서 로드한 feature weights를 `as number[]` 직접 캐스트.
`NaN`/`Infinity` 포함 가중치 → scoring 시 모든 score가 NaN → 전량 ambiguous.
CLAUDE.md Rule 11 (JSONB → Zod 검증) 위반.

### SCAN4-11: finalScore re-clamp 누락

heuristic weighted sum: 각 component [0,1] + weight 합산이 1.0을 초과할 경우 finalScore > 1.0 가능.
`Math.max(0, Math.min(1, finalScore))` clamp 누락. calibration이 [0,1] 입력 가정 → 잘못된 conformal region.

### SCAN4-12: default weights 합산 0.95

`lambdamart-ranker.ts` default heuristic weights: 합산 = 0.95.
`MAX_SCORE = 1.0`이지만 최고 점수 와인도 이론적 max 0.95. calibration 분위수 계산 시 오프셋 발생.

### RCA-04: conformal calibration identity fallback

DB가 비어있으면 `calibrator.loadParams()` → `breakpoint_count: 0` → `clamp01(rawScore)` passthrough.
conformal gate: `score >= 1 - 0.3 = 0.7`. uncalibrated score [0.5, 0.7) → 전량 ambiguous.
**avoidable_abstain_rate 91.2%** = 이 구간에서 실제로는 resolve였어야 할 케이스.

calibration 생성 스크립트 존재: `scripts/eval/calibration-report.ts` — 미실행 상태.

---

## 구현 계획

### Phase 1 — 즉시 abstain 해소 (P0)

**E2-P1-1**: LTR 미사용 시 entropy gate bypass
```typescript
// abstain-policy.ts
shouldAbstain(scores: readonly number[], context: AbstainContext): AbstainDecision {
  if (!context.ltrAvailable) {
    return { abstain: false, reason: 'ltr_unavailable_entropy_bypass' };
  }
  // ... 기존 entropy 계산
}
```
`AbstainContext`에 `ltrAvailable: boolean` 추가. ranker에서 LTR 사용 여부 전달.
**예상 효과**: 83% → <20% ambiguous (LTR 없는 환경에서).

**E2-P1-2**: alpha SSoT 모듈 생성
```typescript
// src/domain/shared/config/conformal-config.ts
export const CONFORMAL_ALPHA = 0.3; // 70% coverage target
```
`resolver.ts:84`, `run-offline-eval.ts:2106` import로 교체.

### Phase 2 — calibration 파이프라인 연결 (P1)

**E2-P2-1**: calibration 데이터 생성
```bash
tsx scripts/eval/calibration-report.ts --input /tmp/pilot200-*.ndjson --output calibration.json
```
생성된 params를 calibration store에 insert.

**E2-P2-2**: 피드백 → calibration 자동 파이프라인
`W2-BUG-10`: eval feedback → calibration-report.ts → DB upsert 자동화.
신규 cron job 또는 `run-eval-and-train-ltr.ts`에 calibration 단계 추가.

**E2-P2-3**: readiness probe 통과 확인
`calibration_store` probe (`readiness.ts:181-188`) `required: true` — DB 채워지면 자동 통과.

### Phase 3 — LTR 파이프라인 정비 (P1~P2)

**E2-P3-1**: dead code 정리 — `ltr-features.ts` 26-feature 시스템
- production import 없음 확인 후 삭제 또는 명시적 archive 처리
- train-serve skew 위험 제거

**E2-P3-2**: `rerank_score` LTR feature 추가
```typescript
// ltr-feature-extractor.ts RankingFeatures 인터페이스
rerankScoreFeature: number; // cross-encoder score, 0.0 if not available
```
ranker.ts에서 cross-encoder score를 feature vector에 포함 후 LTR 학습.

**E2-P3-3**: `feature-parity-hash.ts` wiring
promotion gate 또는 `ltr-training-service.ts`에서 `getCurrentFeatureSchemaHash()` 호출.
모델 registry에 schema hash 기록 → serve-time 불일치 시 경고.

**E2-P3-4**: `extractExtendedLTRFeatures()` 테스트 추가
- `criticScore: undefined` → 0.0 default
- `producerPrestige: undefined` → 0.5 default (비대칭! 0.0 아님)
- 10개 필드 전체 존재 확인

**E2-P3-5a**: LTR 가중치 로드 검증 추가 (SCAN4-10)
```typescript
// lambdamart-ranker.ts
const weightsRaw = await this.weightStore.load();
const weights = WeightsSchema.parse(weightsRaw); // Zod: array of finite numbers
if (weights.some(w => !Number.isFinite(w))) {
  log.warn('LTR weights contain NaN/Infinity — falling back to heuristic');
  return this.heuristicScore(candidate);
}
```

**E2-P3-5b**: finalScore clamp 추가 (SCAN4-11)
```typescript
const finalScore = Math.max(0, Math.min(1, weightedSum));
```
weighted sum 직후 항상 적용.

**E2-P3-5c**: default weights 합산 보정 (SCAN4-12)
```typescript
// 현재 weights = { ... } // 합산 0.95
// 수정: normalize하거나 의도적으로 1.0 맞추고 주석 추가
const WEIGHT_SUM_INVARIANT = 1.0; // all weights must sum to this
```
합산 불일치 시 startup assertion 또는 lint 검사.

**E2-P3-5d**: eval 코퍼스 경로 통일 (RCA-06)
```typescript
// run-eval-and-train-ltr.ts 또는 eval harness 설정
const EVAL_CORPUS_GLOB = '/tmp/pilot200-*.ndjson'; // 실존 파일 패턴
// 기존: '/tmp/test300-v3.ndjson' (없는 파일)
```
eval harness의 모든 corpus path 참조를 glob 패턴 또는 환경변수로 통일.

**E2-P3-5e**: W2-BUG-12 explanation grounding 수정
`human-response-builder-v2.ts`: 설명 텍스트 생성 시 실제 적용된 제약 조건 목록을 context로 주입.
설명에서 언급하는 속성이 실제 필터/soft-constraint에 존재함을 검증.

**E2-P3-5**: LTR 모델 학습 실행 ⚠️ E2-P2-1/P2-2 완료 후 진행
```bash
npm run test:eval  # eval corpus 준비 (RCA-06 수정 후)
tsx scripts/run-eval-and-train-ltr.ts
```
**선행 조건**: calibration store에 데이터 존재 (`breakpoint_count > 0`) 확인 후 실행.

### Phase 4 — 예산 제약 hard 전환 결정 (P3, 팀 합의)

**E2-P4-1**: BUG-09 — 예산 제약 soft → hard 전환 여부 결정
현재 soft = ranking boost만, Vespa WHERE 절 미포함. 6만원 와인이 "5만원 이하" 쿼리 결과에 등장.
변경 시: `rule-based-constraint-extractor.ts:276-296`에서 `hard.push()`로 이동.
팀 결정 필요 (UX 철학: 엄격 필터 vs 유연한 ranking).

---

## 완료 기준 (Definition of Done)

- [ ] LTR 없는 환경에서 ambiguous율 < 20% (eval 500건 기준)
- [ ] NDCG@10 > 0.65 (LTR bypass 후 heuristic 기준)
- [ ] conformal alpha SSoT 모듈 존재, 양쪽 import 확인
- [ ] calibration store 데이터 존재, readiness probe `calibration_store: up`
- [ ] avoidable_abstain_rate < 30%
- [ ] `ltr-features.ts` 26-feature dead code 처리 완료
- [ ] `extractExtendedLTRFeatures()` 테스트 커버리지 100%
- [ ] LTR 모델 학습 완료 + DB에 가중치 존재 (`stubTrain()` 제거 — E5-P4b-7)
- [ ] LTR 가중치 로드 시 NaN/Infinity Zod 검증 통과
- [ ] finalScore 항상 [0,1] 범위 (100건 샘플 테스트)
- [ ] default weights 합산 = 1.0 (assertion 또는 테스트)
- [ ] LTR 사용 시 NDCG@10 > 0.75
- [ ] eval 코퍼스 경로 통일 — `pilot200-*.ndjson` glob으로 eval harness 정상 실행 (RCA-06)
- [ ] calibration 실행 전 `breakpoint_count > 0` gate 확인
- [ ] explanation 언급 속성 = 실제 적용 제약 일치 (W2-BUG-12)
