# E5 — Data Hygiene & SSoT

**목표**: patch-on-patch 없이 코드베이스를 장기적으로 안전하게 유지한다. dead code, 상수 중복, 검증 누락, 마이그레이션 위험을 제거한다.
**영향**: 지금 당장 서비스 오류는 아니지만 방치 시 실제 버그로 발전하는 structural debt. BUG-15처럼 SSoT 위반이 5개 속성 누락으로 이어진 사례 참고.
**SOTA++ 방향**: 상수는 한 곳에, 검증은 경계에서, deprecated는 migration window 내 완주.

---

## 버그 목록

| ID | 심각도 | 제목 | 파일 |
|----|--------|------|------|
| BUG-18 | 🔴 P0 | migration 005 — duplicate 정리 없이 UNIQUE INDEX → 배포 시 실패 | `005_watchlist_dedup_constraint.sql` |
| BUG-15 | 🟠 P1 | `SOFT_CONSTRAINT_ATTRIBUTES` 3곳 중복 — planner.ts 5개 속성 누락 | `planner.ts`, `result-grouper.ts` |
| BUG-DS04 | 🟠 P1 | RRF k=60 SSoT 위반 — `per-class-fusion-config.ts`, `retrieval-profile.ts` 중복 | 4개 파일 |
| BUG-05 | 🟡 P2 | `RECIPROCAL_RANK_FUSION_DEFAULT_K` dead constant in `fusion.ts` | `fusion.ts:37` |
| BUG-06 | 🟡 P2 | `hardFilterTokens`, `planVersion` RetrievalPlan dead fields | `retrieval-plan-builder.ts` |
| BUG-16 | 🟡 P2 | `RedisCache.get<T>()` deprecated unsafe cast 잔존 | `redis-cache.ts:72` |
| BUG-17 | 🟡 P2 | query/embedding 캐시 write-time Zod 검증 없음 | `redis-query-cache.ts`, `redis-embedding-cache.ts` |
| BUG-19 | 🟡 P2 | kill-switch 테스트 — 4개 degradation 조건 미테스트 | `kill-switch-policy.test.ts` |
| BUG-20 | 🟡 P2 | `route-contracts.ts:163` 매직 넘버 100 | `route-contracts.ts` |
| BUG-DS05 | 🟡 P2 | `SECONDS_PER_MINUTE` 5개 파일 중복 선언 | 5개 파일 |
| BUG-DS06 | 🟡 P2 | `watchlist-policy.ts:82` `getTime()` NaN 가드 없음 | `watchlist-policy.ts` |
| BUG-DS07 | 🟡 P2 | `field-normalizer.ts:70` `Number()` isFinite 가드 없음 | `field-normalizer.ts` |
| BUG-DS08 | 🟡 P2 | alias prefix `Math.ceil(N/2)` 경계 테스트 없음 | `pg-alias-repository.ts` |
| BUG-28 | 🟡 P2 | `pg-alias-repository.ts:104` boundary test N=1,2,3,4 없음 | `alias-matcher.test.ts` |
| W2-BUG-11 | 🟡 P2 | `z.record()` 무제한 — policy/uncertainty 필드 | `search-response.schema.ts` |
| W3-01 | 🔴 P0 | `rollbackToSnapshot()` 빈 스냅샷 → `DELETE FROM entities` 전체 삭제 (✅ 수정됨) | `pg-entity-repository.ts:334` |
| SCAN4-04 | 🔴 P0 | ETL `acidity`/`tannin` = 0 silently dropped — "데이터 없음"을 `0`으로 처리해 Vespa 인덱싱 누락 | ETL pipeline |
| SCAN4-09 | 🟠 P1 | ETL LLM critic proxy — numeric string("87") → DB에 string 저장, 나중에 comparison 오류 | ETL pipeline |
| IDX-06 | 🟡 P2 | `preferenceAlignment` 항상 0.5 — 계산 로직 미연결 또는 미구현 | `alignment-scorer.ts` |
| SCAN4-13 | 🟡 P2 | alias bulk insert N+1 쿼리 — 배열을 row-by-row INSERT | `pg-alias-repository.ts` |
| SCAN4-14 | 🟡 P2 | 유럽식 소수점(`,`) 파싱 오류 — "87,5" critic score → NaN | ETL pipeline |
| SCAN4-15 | 🟡 P2 | `generate-aliases.ts`에서 `\b` 사용 — 한글/악센트 문자 경계 오작동 | `generate-aliases.ts` |
| SCAN4-16 | 🟡 P2 | 1자 토큰 alias 매칭 — 단음절 한글 alias가 지나치게 광범위 매칭 | `pg-alias-repository.ts`, `generate-aliases.ts` |
| W6-P0 | 🔴 P0 | `stubTrain()` 하드코딩 — LTR 재학습 실제로 미작동, NDCG=0.72 가짜 반환 | `retrain-orchestrator.ts` |
| W6-P1-1 | 🟠 P1 | `SELECT * FROM entities` LIMIT 없음 — OOM 위험 | `pg-entity-repository.ts:218` |
| W6-P1-2 | 🟠 P1 | embedding readiness probe stub — URL 없을 때 `'up'` 허위 보고 | `readiness.ts` |
| W6-P1-3 | 🟠 P1 | 소프트/하드 제약 분류 split-brain — `constraint-compiler.ts` + `rule-based-constraint-extractor.ts` 독립 결정 | `constraint-compiler.ts`, `rule-based-constraint-extractor.ts` |
| W6-P1-4 | 🟠 P1 | IPS position propensity 하드코딩 — `[1.0, 0.6, 0.4, 0.3, 0.2]` 추정값, 클릭 파이프라인 미연결 | `ips-debiaser.ts` |
| W6-P2-1 | 🟡 P2 | Python ETL `grape_family` `split()[0]` — "Nero d'Avola" → "Nero" 오류 (CLAUDE.md Rule 27) | `enrich-rules.py:303` |
| W6-P2-2 | 🟡 P2 | 드링킹 윈도우 `vintageYear + 2` — 풀바디 레드(Barolo 등) 최소 5-7년 필요 | `drinking-window-predictor.ts` |
| W6-P2-3 | 🟡 P2 | `feedback_signals`, `threshold_proposals` 테이블 인덱스 누락 — 쿼리 성능 저하 | `pg-feedback-repository.ts` |
| W6-P3 | 🔵 P3 | Health probe HTTP 증폭 — k8s liveness 10초마다 × 3서비스 × 6레플리카 = 분당 108 요청 | `readiness.ts` |
| W6-P2-2 | 🟡 P2 | 드링킹 윈도우 `vintageYear + 2` — 풀바디 레드(Barolo 등) 실제 필요 기간 5-7년 | `drinking-window-predictor.ts` |

---

## RCA 요약

### BUG-18: migration 005 — 배포 블로커

기존 duplicate `(user_id, entity_id, callback_url)` 행 정리 없이 UNIQUE INDEX 생성.
프로덕션에 중복 데이터 존재 시 `ERROR: could not create unique index` → migration 실패 → 서비스 기동 불가.

또한 `pg-watchlist-store.ts:92`의 `ON CONFLICT (user_id, entity_id, callback_url) DO NOTHING`이 이 constraint에 의존.
migration 실패 시 constraint 없음 → `ON CONFLICT` 작동 안 함 → idempotency 보장 깨짐.

### BUG-15: SOFT_CONSTRAINT_ATTRIBUTES — planner.ts 버전 5개 누락

SSoT (`constraint-compiler.ts:24-30`): 10개 속성
`planner.ts`: 5개 (price_band, occasion, critic_score, fruit_intensity, finish 누락)
`result-grouper.ts`: 4개 (subset)

`price_band`/`critic_score` 제약이 planner에서 hard로 오분류 → query routing 오류.

### BUG-DS04: RRF k=60 — 4곳 중복

SSoT: `rrf.ts:9` `export const RRF_DEFAULT_K = 60`
중복: `fusion.ts:37`, `per-class-fusion-config.ts:18`, `retrieval-profile.ts:66,79,92` (magic number 4곳)
k 튜닝 시 SSoT만 수정하면 나머지는 구버전 유지 → 채널별 서로 다른 k 사용.

---

## 구현 계획

### W6-P0: stubTrain() 하드코딩 — LTR 피드백 루프 완전 미작동

`retrain-orchestrator.ts`의 `trainModel()`이 실제 `trainLambdaMARTModel()` 대신 `stubTrain()` 호출.
`stubTrain()`은 `NDCG=0.72, MRR=0.61` 고정값 반환 → 모델 registry에 가짜 메트릭 저장.
실제 LTR 재학습이 한 번도 실행되지 않았음. E2의 "LTR 미학습" 근본 원인 중 하나.

### W6-P1-3: 소프트/하드 제약 분류 split-brain

소프트/하드 결정이 두 곳에서 독립적으로 이루어짐:
1. `constraint-compiler.ts:24-30` — `SOFT_CONSTRAINT_ATTRIBUTES` Set으로 결정
2. `rule-based-constraint-extractor.ts` — 내부 로직에서 직접 `soft[]` push

두 곳이 불일치하면 같은 속성이 한 경로에서는 soft, 다른 경로에서는 hard로 처리.
E5-P2-1 (SOFT_CONSTRAINT_ATTRIBUTES SSoT 추출)로 해소 가능.

### SCAN4-04: ETL acidity/tannin = 0 silently dropped

ETL 파이프라인: `acidity = 0` 또는 `tannin = 0`을 falsy로 처리 → Vespa 인덱싱 시 해당 필드 제외.
Rule 26 위반: `value || default` 대신 `value ?? default` 사용해야 함.
결과: 실제 acidity=0 (ex. Moscato) 와인이 acidity 필터 쿼리에 미노출.

### SCAN4-09: ETL critic proxy numeric string

ETL LLM proxy: critic score를 `"87"` (string)으로 반환 → DB에 string 저장.
도메인 코드에서 숫자 비교 시 `"87" > 80` → `true` (JS coercion) 또는 `false` (strict compare).
Rule (schema quality bar): LLM numeric output은 string/number 둘 다 허용하고 `Number.isFinite()` 검증.

### IDX-06: preferenceAlignment 항상 0.5

`alignment-scorer.ts` (또는 해당 모듈): `preferenceAlignment`가 항상 0.5 반환.
사용자 history 기반 개인화 신호가 ranking에 전혀 반영 안 됨.
dead code인지 미연결인지 확인 필요.

### Phase 1 — 배포 블로커 fix (P0)

**E5-P1-1**: migration 005 duplicate 정리 CTE 추가
```sql
-- 005_watchlist_dedup_constraint.sql 선두에 추가
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, entity_id, callback_url
      ORDER BY created_at DESC
    ) AS rn
  FROM watchlists
)
DELETE FROM watchlists WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 이후 기존 UNIQUE INDEX 생성
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_entity_callback
  ON watchlists (user_id, entity_id, callback_url);
```
rollback 절차도 주석으로 문서화: `DROP INDEX IF EXISTS idx_watchlists_user_entity_callback;`

### Phase 1b — ETL P0 fix (P0)

**E5-P1b-1**: acidity/tannin = 0 silently dropped 수정 (SCAN4-04)
```python
# ETL — 수정 전
acidity = row.get('acidity') or None  # 0 → None (WRONG)
# 수정 후
acidity = row.get('acidity')  # 0 is valid
if acidity is not None and not isinstance(acidity, (int, float)):
    acidity = None
```
TypeScript ETL: `value ?? null` 사용, `value || null` 제거.

### Phase 2 — SSoT 위반 수정 (P1)

**E5-P2-1**: `SOFT_CONSTRAINT_ATTRIBUTES` SSoT 추출
```typescript
// src/domain/shared/constants/constraint-attributes.ts (신규)
export const SOFT_CONSTRAINT_ATTRIBUTES = new Set([
  'body', 'sweetness', 'acidity', 'tannin', 'style',
  'price_band', 'occasion', 'critic_score', 'fruit_intensity', 'finish',
]);
```
`constraint-compiler.ts`, `planner.ts`, `result-grouper.ts`에서 import.
`planner.ts`의 누락 5개 속성 자동 복구됨.

**E5-P2-2**: RRF k SSoT 통일
`per-class-fusion-config.ts:18` `RRF_K_DEFAULT` → `import { RRF_DEFAULT_K } from '@shared/utils/rrf.js'`
`retrieval-profile.ts:66,79,92` magic number `fusionK: 60` → `fusionK: RRF_DEFAULT_K`
`fusion.ts:37` dead constant 삭제 (BUG-05 해소)

**E5-P2-3**: 시간 단위 상수 SSoT 추출
```typescript
// src/domain/shared/utils/time-units.ts (신규)
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const MILLISECONDS_PER_SECOND = 1_000;
export const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
```
5개 파일 import로 교체.

### Phase 3 — Dead code 정리 (P2)

**E5-P3-1**: `hardFilterTokens`, `planVersion` RetrievalPlan에서 삭제
```typescript
// retrieval-plan-builder.ts
// hardFilterTokens 계산 줄 삭제
// planVersion 상수 삭제
// RetrievalPlanType에서 두 필드 제거
```
`candidate-pool.ts:215`의 직접 호출 유지 (올바른 방식).

**E5-P3-2**: `RedisCache.get<T>()` deprecated 메서드 제거
호출부 전수 확인 → 모두 `getValidated()`/`getValidatedWithStats()`로 교체 → deprecated 메서드 삭제.

### Phase 4 — 검증 강화 (P2)

**E5-P4-1**: `RedisQueryCache.set()`, `RedisEmbeddingCache.set()` write-time 검증
`setValidated()` 패턴 적용 (RedisPhraseCache와 동일).
write 시점에 Zod 통과 못 하면 캐시에 저장 안 함 → poison entry 원천 차단.

**E5-P4-2**: `watchlist-policy.ts:82` NaN 가드
```typescript
const expiresAtMs = entry.expiresAt.getTime();
const nowMs = now.getTime();
if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false; // fail-safe: expired
return expiresAtMs > nowMs;
```

**E5-P4-3**: `field-normalizer.ts:70` isFinite 가드
```typescript
const value = Number(bareNumber[1]);
if (!Number.isFinite(value)) return null;
```

**E5-P4-4**: `z.record()` 무제한 → `boundedRecord()` 적용 (W2-BUG-11)
`search-response.schema.ts`의 `z.record()` 필드에 키/값 길이 제한 추가.

**E5-P4-5**: `route-contracts.ts:163` 매직 넘버
```typescript
const CLAUDE_TOOLS_LIST_MAX = 100; // currently 4 tools; cap prevents unbounded LLM response
tools: z.array(z.unknown()).max(CLAUDE_TOOLS_LIST_MAX),
```

### Phase 4b — ETL + alias P1/P2 수정

**E5-P4b-1**: ETL critic score numeric string coercion (SCAN4-09)
```python
# ETL
raw = row.get('critic_score')
if isinstance(raw, str):
    # handle European comma decimal
    raw = raw.replace(',', '.')
score = float(raw) if raw is not None else None
if score is not None and not math.isfinite(score):
    score = None
```
DB 저장 전 항상 `float | None`, string 금지.

**E5-P4b-2**: 유럽식 소수점 comma 파싱 (SCAN4-14)
ETL의 모든 `float()` 변환 전에 `value.replace(',', '.')` 적용.
"87,5" → 87.5, "8.250" (European thousand) → 별도 처리.

**E5-P4b-3**: `generate-aliases.ts` `\b` 제거 (SCAN4-15)
CLAUDE.md Rule 8 적용: `\b` → `(?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}])` with `/u` flag.
한글 alias "샤르도네" 등이 정확한 경계에서 매칭되도록 수정.

**E5-P4b-4**: 1자 토큰 alias 필터 (SCAN4-16)
```typescript
// generate-aliases.ts 또는 pg-alias-repository.ts
const MIN_ALIAS_LENGTH = 2; // 1자 alias는 false positive 비율 너무 높음
aliases = aliases.filter(a => a.length >= MIN_ALIAS_LENGTH);
```
도메인 근거: 단음절 한글은 조사/어미와 혼동, 실용 min length = 2.

**E5-P4b-5**: alias bulk insert N+1 → batch (SCAN4-13)
```typescript
// pg-alias-repository.ts — N+1 제거
await pg.query(
  `INSERT INTO aliases (entity_id, alias) SELECT * FROM unnest($1::uuid[], $2::text[])`,
  [entityIds, aliasTexts],
);
```

**E5-P4b-7**: `stubTrain()` → 실제 학습으로 교체 (W6-P0)
```typescript
// retrain-orchestrator.ts
async trainModel(): Promise<TrainResult> {
  // stubTrain() 제거
  return await this.trainLambdaMARTModel(this.trainingConfig);
}
```
E2-P3-5와 연동. stub 제거 후 실제 eval 코퍼스로 검증.

**E5-P4b-8**: `SELECT * FROM entities` LIMIT 추가 (W6-P1-1)
```typescript
// pg-entity-repository.ts:218
SELECT * FROM entities LIMIT $1
// 기본값: 10_000 또는 설정 가능한 상수
```

**E5-P4b-9**: embedding readiness probe stub 수정 (W6-P1-2)
embedding URL 없을 때 `'up'` 대신 `'degraded'` 또는 `'down'` 반환.

**E5-P4b-10**: IPS propensity — TODO 주석 + 클릭 파이프라인 연결 계획 (W6-P1-4)
하드코딩 값에 `// TODO: replace with click-stream calibrated propensity after Epic-18` 주석.
연결 완료 전까지 값을 상수로 추출하여 단일 변경점 확보.

**E5-P4b-11**: DB 인덱스 추가 마이그레이션 (W6-P2-3)
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_feedback_signals_query_class
  ON feedback_signals (query_class);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threshold_proposals_status
  ON threshold_proposals (status);
```

**E5-P4b-12**: Python ETL grape_family lookup 테이블 (W6-P2-1)
```python
MULTI_WORD_GRAPE_FAMILIES = {
  "Nero d'Avola": "Nero",
  "Sauvignon Blanc": "Sauvignon",
  "Pinot Noir": "Pinot",
  # ...
}
grape_family = MULTI_WORD_GRAPE_FAMILIES.get(variety, variety.split()[0])
```

**E5-P3-3**: W6-P3 health probe 개선 (P3)
k8s liveness probe용 lightweight `/healthz` 엔드포인트 분리.
기존 `/readiness`는 external HTTP 호출 포함 → startup/readiness probe 전용 유지.
liveness probe: process alive 체크만 (HTTP 증폭 없음).

**E5-P4b-6**: `preferenceAlignment` 연결 확인 (IDX-06)
`alignment-scorer.ts`의 반환값이 실제로 ranking 입력으로 전달되는지 확인.
dead code이면 삭제, 미연결이면 LTR feature vector에 포함.

### Phase 5 — 테스트 보강 (P2)

**E5-P5-1**: kill-switch 테스트 4개 degradation 조건 추가
- `KILL_SWITCH_DENSE_RETRIEVAL=true` → `denseRetrievalEnabled: false`, mode degraded
- `KILL_SWITCH_LEARNING=true` → `learningKillSwitchEnabled: true`, mode degraded
- `RERANKER_SERVICE_URL='   '` (whitespace) → `rerankerAvailable: false`
- degradation signal 존재 시 mode hint 변경

**E5-P5-2**: alias prefix `Math.ceil(N/2)` 경계 테스트
```typescript
// alias-matcher.test.ts
it.each([
  [1, 1], // ceil(0.5) = 1
  [2, 1], // ceil(1.0) = 1
  [3, 2], // ceil(1.5) = 2
  [4, 2], // ceil(2.0) = 2
  [5, 3], // ceil(2.5) = 3
])('prefix length for input length %i → %i', (inputLen, expectedPrefix) => { ... });
```
주석: `Math.ceil` 선택 이유 = "≥50% prefix coverage for recall-first fuzzy matching".

---

## 완료 기준 (Definition of Done)

- [ ] migration 005 프로덕션 DB에서 duplicate 있을 때도 성공적으로 실행
- [ ] `planner.ts`가 `price_band`, `critic_score` 등 5개 속성을 soft로 올바르게 분류
- [ ] `rrf.ts` 변경 시 `per-class-fusion-config.ts`, `retrieval-profile.ts` 자동 반영
- [ ] `RetrievalPlan`에 `hardFilterTokens`, `planVersion` 필드 없음
- [ ] `RedisCache.get<T>()` deprecated 메서드 코드베이스에서 삭제됨
- [ ] Redis write-time Zod 검증: poisoned entry 사전 차단 테스트 통과
- [ ] kill-switch 테스트 — 4개 degradation 조건 모두 커버
- [ ] alias prefix `Math.ceil` N=1,2,3,4,5 경계 테스트 존재
- [ ] ETL: `acidity=0` 와인 → Vespa 필드 존재 확인 (null 아님)
- [ ] ETL: `"87,5"` critic score → DB `float 87.5` 저장 확인
- [ ] `generate-aliases.ts` `\b` 없음 — lint 통과
- [ ] 1자 alias → insert 차단 (MIN_ALIAS_LENGTH=2 테스트)
- [ ] alias insert: N개 → 쿼리 1회 (N+1 없음)
- [ ] `preferenceAlignment` — dead code이면 삭제됨, 미연결이면 LTR feature에 포함됨
- [ ] W6-P0: `stubTrain()` 제거 → `trainLambdaMARTModel()` 실제 호출 + non-stub 결과 반환 확인
- [ ] W6-P1-1: `SELECT * FROM entities` → LIMIT 포함, 10k+ 엔티티 환경에서 OOM 없음
- [ ] W6-P1-2: embedding URL 없을 때 readiness `embedding: degraded` (not `up`)
- [ ] W6-P1-3: soft/hard 분류 — `constraint-compiler.ts`와 `rule-based-constraint-extractor.ts` 동일 SSoT 사용 확인 (E5-P2-1 완료 후)
- [ ] W6-P2-1: "Nero d'Avola" → `grape_family: "Nero"` 아닌 올바른 값 반환 (lookup 테스트)
- [ ] W6-P2-3: `feedback_signals(query_class)`, `threshold_proposals(status)` 인덱스 존재 확인
