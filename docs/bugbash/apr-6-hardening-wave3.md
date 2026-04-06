# Apr 6 — Hardening Wave 3 (P0 bootstrap → honesty → tests)

**목적:** “설계/문서/placeholder”가 아니라 **부트스트랩·권위 결정론·계약 정직성·프로덕션 경로 테스트**가 한 줄로 닫히게 만든다.  
**범위:** Phase 0(P0) 중심 + Wave 3에서 바로 이어질 결정론 레일·honesty contract·스키마·eval 정책·CI 스모크까지 **실행 가능한 작업 단위**로 고정한다.

**상위 로드맵:** `docs/rfc-apr-6-retrieval-improvement-roadmap.md` §13.1에서 Wave 3과 본 문서를 상호 참조한다.

---

## 구현 반영 상태 (요약)

아래는 **코드·문서에 반영된 항목**과 **아직 후속인 항목**을 구분한다.

| 항목 | 상태 | 비고 |
|------|------|------|
| Canonical JSON + `deterministicHash` SSOT | 완료 | `canonical-json.ts`, `hash.ts` |
| Authority / admission / snapshot / batch id + schema version | 완료 | `authority-trace.ts`, `id-schema-version.ts`, `decision-engine`, `admission-gate`, `pg-snapshot-store`, `batch-search.usecase` |
| `AdmissionSignals` / `decideAdmission` | 완료 | `admission-policy.ts`; confidence 단독 거절은 `ConfidenceRefusalPolicy`와 중복되지 않게 구성 |
| Cache / kill-switch 정책 모듈 | 완료 | `cache-policy.ts`, `kill-switch-policy.ts` + `main` 부팅 로그 |
| HTTP 응답 계약 (authority·runtime·execution_mode 등) | 완료 | `search-response.schema.ts`, `response-builder`, domain 모델 |
| Observability (`SearchLogSchema` + emit) | 완료 | `src/observability/*`, post-route |
| Replay fixture JSON + 구조 테스트 | 완료 | `test/replay-fixtures/search/*.json`, `test/unit/replay-fixtures/run-search-replay.test.ts` |
| `migrate` = `tsx`, `bootstrap:smoke`, CI workflow | 완료 | `package.json`, `scripts/bootstrap-smoke.sh`, `SKIP_MIGRATE`, `.github/workflows/bootstrap-smoke.yml` |
| `scripts/migrate.ts` 상단 `process.exit(0)` 제거 | 완료 | 자연 종료 |
| Readiness probes **SSOT 단일화** | 완료 | SSOT: `src/infrastructure/health/readiness-probes.ts`; `src/config/readiness.ts`·`src/config/__tests__/readiness-probes.test.ts`가 동일 모듈 참조; config 쪽 `readiness-probes.ts`는 제거됨 |
| 루트 `.env.example` | 완료 | `env.ts` 키와 주기적으로 1:1 동기화 권장 |
| README / dead CLI (`ingest`·`kill-switch` 가짜 스크립트) | **점검 권장** | 루트 `package.json`에 과거형 broken CLI는 없음; `README`/`AGENTS`/`CLAUDE` 언급만 실제와 맞는지 가끔 확인 |
| `decideResponseCachePolicy` → `CacheService` write 경로 | 완료 | `CacheService.setSearchResponse`에서 정책으로 비캐시 응답은 쓰기 스킵 (`cache-service.ts`) |
| Eval `eval-metric-policy` / advisory vs blocking 분리 | **후속** | `scripts/eval/eval-metric-policy.ts` 미도입; `run-offline-eval`·baseline 회귀와 연동은 별 작업 |
| Replay fixture 전체 HTTP `runSearchFixture` | **후속** | 구조 검증만 존재; 통합 리플레이는 컨테이너·서비스 붙인 뒤 |
| ID 스키마 버전별 replay/audit **디코더** | **후속** | `id-schema-version.ts` 상수만; 버전별 파서·검증기는 미구현 |

---

## 현재 스냅샷 (레포 기준)

| 항목 | 상태 |
|------|------|
| `.env.example` | 루트에 존재; 키 추가·변경 시 `src/config/env.ts`와 맞출 것 |
| `package.json` `migrate` / `bootstrap:smoke` | `tsx scripts/migrate.ts`, `bash scripts/bootstrap-smoke.sh` |
| Readiness | 단일 모듈 `src/infrastructure/health/readiness-probes.ts` (config 전용 duplicate 파일 없음) |
| Broken `ingest` / `kill-switch` npm scripts | **없음** (`test:ingest:*` 등은 테스트 레인) |

## 초기 감사 스냅샷 · 히스토리 (Wave 3 이전)

아래는 과거에 관찰했던 베이스라인이다. 위 “현재 스냅샷”과 대조용.

| 항목 | 당시 상태 |
|------|-----------|
| `.env.example` | 없음 — `README.md`는 `cp .env.example .env` 안내 |
| `package.json` `ingest` / `kill-switch` | `tsx src/interface/cli/*.ts` — **CLI 파일 부재 시 깨짐** |
| `package.json` `migrate` | `node --experimental-vm-modules scripts/migrate.ts` — TS 직접 실행 형태, **깨질 가능성** |
| Readiness probes | `src/config/readiness-probes.ts`와 `src/infrastructure/health/readiness-probes.ts` **중복** |
| `src/config/readiness.ts` | `./readiness-probes.js` import (config 쪽) |
| `src/config/__tests__/readiness-probes.test.ts` | **이미** `../../infrastructure/health/readiness-probes.js` — **prod와 불일치** |

---

## P0 — 0-1. 부트스트랩 깨짐 정리

### 건드릴 파일

- `README.md`
- `package.json`
- **신규** 루트 `.env.example`
- 선택: `scripts/bootstrap-smoke.sh` (또는 `npm run bootstrap:smoke`만)

### 왜 (원칙 — 대부분 반영됨)

- README는 `.env.example`을 가정한다 → 루트 `.env.example` **추가됨**; 키 drift 방지를 위해 `env.ts`와 주기 동기화.
- 존재하지 않는 CLI를 npm script로 노출하면 **“있는 척”** 이 된다 → broken `ingest`/`kill-switch` 스크립트는 **제거된 상태** 유지.
- `migrate`는 `tsx scripts/migrate.ts` 등 **실제로 돌아가는 형태**로 통일 → **반영됨**.

### 실제 수정 — `package.json` (권장 형태)

```json
{
  "scripts": {
    "migrate": "tsx scripts/migrate.ts",
    "bootstrap:smoke": "bash scripts/bootstrap-smoke.sh"
  }
}
```

(`bootstrap-smoke.sh`는 내부에서 `npm ci` → `typecheck` → `build` → `verify:http-contracts` → 선택적 `migrate`; CI에서는 `SKIP_MIGRATE=1`.)

**더 좋은 선택:** `ingest`, `kill-switch`는 **삭제** (없는 기능을 스크립트로 노출하지 않음).  
대안으로만 유지할 경우: `echo '… not implemented' && exit 1` — 문서와 반드시 일치.

### `.env.example` — `src/config/env.ts` 기준 최소 세트

아래는 **필수로 노출**하고, 선택값은 주석 블록으로 분리한다.

**필수 (예시 키):**

- `NODE_ENV`, `PORT`, `LOG_LEVEL`
- HTTP: `HTTP_RATE_LIMIT_MAX`, `HTTP_TRUST_PROXY`, `HTTP_BODY_LIMIT_BYTES`, `HTTP_SECURITY_HEADERS`, `CORS_ALLOWED_ORIGINS`
- `EVAL_RUN_AT_STARTUP`
- PG: `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `PG_POOL_MAX`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`
- `REDIS_URL`
- Vespa: `VESPA_URL`, `VESPA_CONTENT_CLUSTER`
- Embedding: `EMBEDDING_SERVICE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_HTTP_TIMEOUT_MS`
- Reranker: `RERANKER_SERVICE_URL`, `RERANK_BLEND_SCALE`, `RERANKER_HTTP_TIMEOUT_MS`
- `LEARNED_MATCHER_HTTP_TIMEOUT_MS`
- `INJECTION_JUDGE_FAIL_OPEN`, `ALLOW_HEURISTIC_DRINKING_WINDOW`
- Kill switches: `KILL_SWITCH_ALIAS_OVERLAY`, `KILL_SWITCH_LEARNING`, `KILL_SWITCH_DENSE_RETRIEVAL`, `KILL_SWITCH_INJECTION_JUDGE`, `KILL_SWITCH_QUERY_CACHE`

**선택 (주석으로 분리 예시):**

- `LEARNED_MATCHER_SERVICE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_INJECTION_MODEL`
- `DRINKING_WINDOW_MODEL_DIR`
- `WATCHLIST_ENABLED`, `WEBHOOK_SECRET`, `CONFIDENCE_REFUSAL_THRESHOLD`

구현 시 **`env.ts`의 실제 키 이름·기본값**과 1:1 대조해 누락/오타를 막는다.

### `README.md` — 빠른 시작 (권장)

```bash
npm ci
cp .env.example .env
npm run migrate
npm run dev
```

**반드시 추가할 문구:**

- `ingest` / `kill-switch` CLI가 **미구현이면** 문서·npm scripts 어디에도 “있는 척” 하지 않는다.
- `DRINKING_WINDOW_MODEL_DIR` 미설정 시 **heuristic fallback**이 어떻게 동작하는지 명시 (내부 동작과 계약을 맞춤).

---

## P0 — 0-2. Readiness probe 중복 제거 (SSOT)

**상태: 완료.** SSOT는 `src/infrastructure/health/readiness-probes.ts`이며, `src/config/readiness.ts`와 `src/config/__tests__/readiness-probes.test.ts`가 해당 모듈만 참조한다. `src/config/readiness-probes.ts`는 삭제됨.

### 당시 건드린 파일 (참고)

- `src/config/readiness.ts`
- ~~`src/config/readiness-probes.ts`~~ (삭제됨)
- SSOT: `src/infrastructure/health/readiness-probes.ts`
- `src/config/__tests__/readiness-probes.test.ts`
- `src/config/__tests__/readiness.test.ts` (import 경로 정합)

### 방향 (달성됨)

- **SSOT:** `src/infrastructure/health/readiness-probes.ts`
- `src/config/readiness.ts`에서 infra 쪽만 import:

```ts
import { probeJsonPostEndpoint } from '../infrastructure/health/readiness-probes.js';
```

- **`src/config/readiness-probes.ts` 삭제** — 완료
- 모든 테스트·프로덕션 import를 **동일 경로**로 통일 → “테스트는 infra, prod는 config” drift 제거

### 완료 조건

- `/ready`를 구성하는 코드 경로와 단위 테스트가 **같은 모듈**을 본다. **충족.**

---

## 1. 결정론 레일 닫기

### 1-1. Decision / admission trace — `authority` vs `runtime`

**건드릴 파일 (대표):**

- `src/domain/decision/service/decision-engine.ts` (`Date.now()` 기반 trace 제거)
- `src/domain/decision/service/admission-gate.ts`
- **신규 권장:** `src/domain/decision/service/authority-trace.ts`
- `src/domain/decision/model/decision-output.ts`
- `src/domain/response/model/engine-decision.ts`
- `src/domain/response/model/counterfactual.ts`
- `src/domain/response/service/response-builder.ts`
- `src/interface/http/schemas/search-response.schema.ts`

**정책:**

| 식별자 | 용도 |
|--------|------|
| `authorityTraceRef` (또는 `authority_trace_ref`) | replay / cache key / baseline / audit — **결정론적** |
| `runtimeCorrelationRef` (또는 `runtime_correlation_ref`) | 로깅·트레이싱·지원 — 비결정론 허용 |

**구현 스케치:** `deterministicHash`는 `src/domain/shared/utils/hash.ts`의 기존 함수 사용.  
`authority-trace.ts`에서 `queryPlan`, `DecisionSnapshot`, `chosenEntityId`, `decisionStatus`, `nextAction`, `failureReason` 등을 **안정적인 순서**로 해시.

### 1-2. Batch id

**건드릴 파일:** `src/application/search/batch-search.usecase.ts`

- `batch_id`: 쿼리 목록 등 입력에 대한 **결정론적** id (canonical normalize + `deterministicHash`)
- `batch_request_id` (또는 동등): 관측용 런타임 id — **별도**
- **정책 명시:** 쿼리 순서가 의미 있으면 그대로, 무관하면 sort 후 hash 등 규칙을 문서·테스트에 박는다.

### 1-3. Snapshot id (`pg-snapshot-store`)

**건드릴 파일:** `src/infrastructure/adapter/pg-snapshot-store.ts` (+ 필요 시 `snapshot-store.port.ts`)

- `Date.now().toString(36)` 제거
- `threshold_profile_id`, planner/policy 버전, **canonical snapshot content digest**로 id 구성
- `JSON.stringify` 키 순서 흔들림 방지: **canonical JSON** 유틸 권장

---

## 2. Honesty contract 닫기

### 2-1. Response meta / engine decision

**필드 (최소):**

- `execution_mode`: `authoritative` \| `degraded` \| `heuristic` \| `advisory`
- `blocking_eligible`: boolean
- `degradation_reasons?`: string[]
- `authority_trace_ref?` (기존 `decision_trace_ref`와 역할 분리 — 하위호환은 별도 절 참고)

**건드릴 파일:** `counterfactual.ts`, `engine-decision.ts`, `response-builder.ts`, `search-response.schema.ts`, `search-usecase-map-result-items.ts`, `result-item.ts`

### 2-2. Drinking window — heuristic 계약 노출

**건드릴 파일:** `drinking-window-predictor.ts`, `drinking-window-confidence.ts`, `search-usecase-map-result-items.ts`, `result-item.ts`, `search-response.schema.ts`

- `DrinkingWindowBlock`: `evidence_level`: `learned` \| `heuristic`, `blocking_eligible?`
- 휴리스틱 모델 버전(`heuristic-*`)이면 `evidenceLevel: heuristic`, `blockingEligible: false` 등 **규칙 고정**

### 2-3. Eval — advisory metric 정책 분리

**건드릴 파일:** `scripts/eval/metrics.ts`, `scripts/eval/run-offline-eval.ts`  
**신규 권장:** `scripts/eval/eval-metric-policy.ts`

- `MetricPolicy`: `blocking` \| `advisory`
- placeholder 성격 지표(`set_diversity_score`, `anchor_preservation_score`, `producer_variety` 등)는 **advisory**
- baseline regression **fail trigger에서 advisory 제외**
- 결과 JSON에 `policy` / `non_blocking_metrics` 등으로 **게이트와 시각적으로 분리**
- 함수명 정직화: `advisorySetDiversityScore` 등 (선택이지만 권장)

---

## 3. 검색 authority pipeline — degraded semantics 반영

**건드릴 파일:**

- `src/config/readiness.ts` (옵션/다운 처리와 응답 계약의 정합)
- `search-usecase-post-route-phase.ts`, `search.usecase.ts`
- `response-builder.ts`, `counterfactual.ts`
- ML 어댑터: `src/infrastructure/ml/...`, `learned-matcher` HTTP 어댑터

**규칙 예시 (단일화):**

- learned matcher / reranker timeout·disabled → `degraded` + `degradation_reasons`
- drinking window heuristic-only → `heuristic` + 이유
- advisory-only eval 경로 → `advisory`
- snapshot pinned + 전 구간 정상 → `authoritative`

**선호:** `ResponseBuilder` 단독 추론보다 **post-route phase에서 신호 수집 후** builder에 전달.

---

## 4. 테스트 — prod 경로와 결정론

### 4-1. Readiness

- import를 prod와 **동일**하게
- config dead file 삭제 후 테스트만 남는 상황 방지
- drinking-window heuristic / degraded는 **HTTP 응답 meta surface** 테스트 추가 권장

### 4-2. 결정론 단위 테스트 (신규 권장)

| 파일 | 내용 |
|------|------|
| `src/domain/decision/__tests__/authority-trace.test.ts` | 동일 입력 → 동일 `authorityTraceRef`; entity 변경 시 해시 변경 |
| `src/infrastructure/adapter/__tests__/pg-snapshot-store-id.test.ts` | 동일 스냅샷 내용 → 동일 id; 버전 변경 시 id 변경 |
| `test/unit/application/search/batch-search.usecase.test.ts` (batch id 케이스) | 동일 쿼리 집합 → 동일 `batch_id` 형식·변경 감지; 전용 파일명 `batch-search-id.test.ts`는 사용하지 않음 |

### 4-3. Bootstrap smoke

- **신규:** `test/e2e/bootstrap-smoke.test.ts` 또는 `scripts/bootstrap-smoke.sh`
- 점검: `.env.example` 존재, `npm run build`, `verify:http-contracts`, `migrate` 최소 실행 가능, readiness options 빌드
- **CI lane**에 편입 (기존 workflow에 job 추가)

---

## 5. Search response schema — trace 이름 정직화

**건드릴 파일:** `search-response.schema.ts`, `search-response.ts`, `counterfactual.ts`, `engine-decision.ts`, `response-builder.ts`

**권장:**

- `authority_trace_ref` — 권위·replay용
- `runtime_correlation_ref` — 관측용
- 기존 `decision_trace_ref`는 **하위호환 유지 + deprecated** (내부 주석·OpenAPI description에 명시)

---

## 6. 보너스

### 6-1. `scripts/migrate.ts`

- `process.exit(0)` 제거 검토 — 성공 시 자연 종료, 실패 시 non-zero

### 6-2. 문서 정리

- `src/interface/cli`가 비어 있으면 `README.md` / `AGENTS.md` / `CLAUDE.md`에서 **CLI 진입점 언급**을 실제와 맞추거나 삭제

---

## 권장 실행 순서 (캘린더)

| 일차 | 내용 | 상태 |
|------|------|------|
| **1** | `.env.example` 추가, `package.json` migrate·ingest/kill-switch 정리, README 빠른 시작·면책 문구 | **대부분 완료** — README·문서 언급만 주기 점검 |
| **2** | readiness probes SSOT, 테스트 import 통일, `readiness-probes.ts`(config) 삭제 | **완료** |
| **3–4** | `authority-trace.ts`, decision-engine / admission-gate 적용, `pg-snapshot-store` snapshot id, `batch-search` id | **완료** |
| **5–6** | ResponseMeta / EngineDecision / DrinkingWindowBlock / schema / builder / 매핑 + 테스트 | **완료** |
| **7** | `eval-metric-policy`, advisory 분리, bootstrap smoke + **CI** | **부분 완료** — bootstrap smoke·CI는 있음; eval 정책 모듈은 **후속** |

---

## 완료 조건 (Wave 3 exit)

1. **새 머신:** README만으로 `npm ci` → `.env` → `migrate` → `dev` 가능 (또는 명시된 전제 하에 가능). *(루트 `.env.example` 존재; README 절차와 계속 정합 유지.)*
2. **npm scripts:** 문서·`package.json`·실제 파일이 **빈약한 기능을 가장하지 않음**. *(broken `ingest`/`kill-switch` 엔트리는 제거된 상태.)*
3. **Readiness:** 단일 SSOT, 테스트=프로덕션 import. *(§0-2 **완료**.)*
4. **Authority:** 동일 입력·동일 스냅샷 → 동일 authority 식별자; batch/snapshot id가 시간/랜덤에 의존하지 않음. *(코드 반영됨.)*
5. **계약:** execution/evidence/degradation이 응답에 노출; eval advisory는 blocking 게이트와 분리. *(HTTP/검색 계약은 반영; **eval** advisory·`eval-metric-policy`는 `scripts/eval` **후속**.)*
6. **CI:** bootstrap smoke lane이 typecheck·build·contract 등 회귀를 잡음. *(`.github/workflows/bootstrap-smoke.yml`.)*

---

## 1-4. Canonical serialization SSOT

- authority trace / batch id / snapshot id / `response_hash` 입력은 모두 `canonicalJsonStringify()` (`src/domain/shared/utils/canonical-json.ts`)를 단일 직렬화 규약으로 사용한다.
- `JSON.stringify()`를 authority 입력에 직접 쓰지 않는다.
- `undefined`는 제거, `null`은 유지.
- object key는 사전순 정렬.
- 배열 순서는 의미가 있는 경우 보존한다.
- 비유한/NaN 숫자는 금지한다.

`deterministicHash` (`src/domain/shared/utils/hash.ts`)는 각 파트를 위 규약으로 직렬화한 뒤 SHA-256 전체 hex digest를 반환한다.

---

## 1-5. ID schema versioning

- `authority_trace_ref`, snapshot id, batch id는 문자열 prefix에 schema version을 포함한다 (`src/domain/decision/model/id-schema-version.ts`: `AUTHORITY_TRACE_SCHEMA_VERSION`, `SNAPSHOT_ID_SCHEMA_VERSION`, `BATCH_ID_SCHEMA_VERSION`).
- hash input 필드 집합이 바뀌면 해당 상수를 올리고, replay/audit는 schema version별 decoder/validator를 유지한다.

---

## 2-4. Admission decision table

코드 SSOT: `src/domain/decision/service/admission-policy.ts` (`decideAdmission`).

- route unhealthy → reject
- blocking requested + heuristic only → reject
- ambiguity high → clarify (게이트에서 `AMBIGUITY_BLOCKED` 등으로 매핑)
- evidence insufficient → clarify
- (선택) confidence floor는 `ConfidenceRefusalPolicy`가 주입된 경우에만 별도 처리 — 레거시 “정책 없음” 경로와 중복 거절을 피한다.

---

## 3-1. Cache / invalidation policy

코드 SSOT: `src/domain/cache/cache-policy.ts` (`decideResponseCachePolicy`). **쓰기 경로:** `src/domain/performance/service/cache-service.ts`의 `setSearchResponse`가 위 정책으로 응답 캐시 쓰기를 게이트한다.

- `authoritative` + snapshot이 명시된 응답만 장기 캐시 후보.
- `degraded` / `heuristic` / `advisory` 응답은 기본 비캐시.
- cache key 설계 시 `authority_trace_ref` + snapshot 식별자 + contract version을 함께 묶는다.
- snapshot / contract version 변경 시 authority 캐시 무효화.
- advisory metric 정의 변경만으로는 response cache 무효화 사유로 삼지 않는다.

---

## Kill switch policy table

코드 SSOT: `src/config/kill-switch-policy.ts` — 부팅 시 `logKillSwitchPolicyAtStartup`으로 각 row의 effect를 구조화 로그한다.

| Key | Effect | Meaning |
|-----|--------|---------|
| `KILL_SWITCH_LEARNING` | degraded_only | learned ranking/matching 비활성 시 degraded 의미로 처리 |
| `KILL_SWITCH_INJECTION_JUDGE` | request_fail | injection judge 경로가 꺼진 보안 모델에서 요청 실패 가능 |
| `ALLOW_HEURISTIC_DRINKING_WINDOW` | degraded_only | learned predictor 부재 시 heuristic-only로 갈 수 있음 |

(추가 키는 표와 코드에 같이 넣어 drift 방지.)

---

## 4-4. Replay fixture suite

- 디렉터리: `test/replay-fixtures/search/` — 시나리오별 JSON + `expected.execution_mode` / `expected.degradation_reasons`.
- 구조 검증: `test/unit/replay-fixtures/run-search-replay.test.ts`.
- 전체 HTTP 리플레이는 컨테이너·서비스가 필요하므로 후속으로 `runSearchFixture` 헬퍼와 통합.

---

## 5-1. Contract migration plan

- 기존 `decision_trace_ref`는 deprecated로 유지(Phase A 동시 노출).
- 신규 필드: `authority_trace_ref`, `runtime_correlation_ref`, `execution_mode`, `blocking_eligible`, `degradation_reasons` (Zod: `search-response.schema.ts`).
- **Phase A:** 신·구 필드 동시 노출, contract 테스트는 둘 다 허용.
- **Phase B:** 다운스트림 마이그레이션 후 `decision_trace_ref`는 optional·deprecated 유지.
- **Phase C:** major에서 `decision_trace_ref` 제거.

---

## Observability schema

- 타입: `src/observability/search-log-schema.ts`
- emit: `src/observability/log-search-event.ts` — `runSearchPostRoutePhase` / `runRankedRouteDecisionPhase`에서 호출(`engineDecision.decisionSnapshot`이 있을 때만).

---

## Wave 3.5 — 운영 closure 보강

### 추가 필수 항목

- [x] canonical serialization SSOT 추가 (`canonicalJsonStringify`)
- [x] authority / snapshot / batch id schema versioning 추가
- [x] cache / invalidation policy 명시 (`cache-policy.ts`)
- [x] kill switch fail-closed policy table 추가 (`kill-switch-policy.ts`)
- [x] OpenAPI deprecated field migration plan 추가 (본 문서 §5-1)
- [x] admission decision table 코드화 (`admission-policy.ts`)
- [x] replay / golden fixture suite 추가 (디렉터리 + 구조 테스트)
- [x] observability field schema 고정 (`search-log-schema.ts`)

### Exit criteria

- [x] authority rail이 canonical serialization SSOT를 단일 사용한다 (`deterministicHash` 경유).
- [ ] id schema 변경 시 replay/audit 디코더가 버전별로 유지된다 (문서·코드 상수 준비됨, 디코더는 후속).
- [x] degraded/heuristic 응답이 캐시 레이어에서 기본 차단된다 (`decideResponseCachePolicy` + `CacheService.setSearchResponse` 쓰기 게이트).
- [x] kill switch가 부팅 로그에 effect로 명시된다.
- [x] OpenAPI migration이 하위호환/제거 시점을 문서에 포함한다.
- [x] admission 결과가 `decideAdmission` 정책으로 재현 가능하다.
- [x] replay fixtures가 execution mode / degradation reasons 스키마를 검증한다 (구조 수준).
- [x] logs가 동일 observability schema(`SearchLogSchema`)를 사용한다.

---

## 참고

- 상위 로드맵: `docs/rfc-apr-6-retrieval-improvement-roadmap.md`
- 본 문서는 **구현 체크리스트**이며, 세부 API 모양은 OpenAPI/계약 테스트(`verify:http-contracts`)와 함께 갱신한다.
