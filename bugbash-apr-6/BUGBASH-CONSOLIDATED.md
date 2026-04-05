# Bugbash Apr-6 — Consolidated (Root Cause)

> 8개 감사 문서(BACKLOG/TASKS/GAPS/FINDINGS-MATRIX/AUDIT-LOG/AUDIT-SNAPSHOT/PLANS-GAP-AUDIT/README)를
> **root cause 기준 15개 그룹**으로 통합. 증상별 중복 제거, patch-on-patch 해소.
>
> 이 파일이 유일한 SSOT. 기존 파일은 아카이브 참고용.

**검증 스냅샷** (2026-04-06):
- `npm run typecheck` — PASS
- `npm run test` — 1083 tests, 68 files, PASS
- `npm run lint` — 214 errors (exit 1)

---

## P0 — 측정/보안이 깨지는 항목

### RC-01: Planner `determineRetrievalMode` — 3개 모드 미반환

**Root cause:** `producer_browse`, `region_browse`, `no_match_detection` 모드가 planner에서 반환되지 않음.

**파생 증상 (기존 5건 → 1건으로 통합):**
- ~~G-02~~ 골든 쿼리 `retrieval_mode` 태그와 축 불일치
- ~~G-08~~ `BrowseRetriever`/`CompareRetriever` 빈 스텁 (모드가 없으니 호출 안 됨)
- ~~G-09~~ `ResultGrouper` 미연결 (browse 결과가 없으니 그룹핑 불가)
- ~~G-31~~ `mode-metrics.ts` 파일 없음 (모드 자체가 없으니 메트릭도 없음)
- ~~BACKLOG P0-2, P1-3, P1-4~~ 전부 이 root cause에서 파생

**수정:** `planner.ts` `determineRetrievalMode()`에 3개 모드 분기 추가 → Browse/Compare retriever 배선 → ResultGrouper 연결

**재현:** `rg "return '(producer_browse|region_browse|no_match_detection)'" src/domain/query/service/planner.ts` → 0건

---

### RC-02: 오프라인 eval 시나리오 매핑 오류

**Root cause:** `scripts/eval/run-offline-eval.ts`의 `ENTITY_TARGET_TYPE_MAP`이 Epic 2 문서(시나리오 A-H)와 의미 불일치. E=exploration인데 producer로, F=comparison인데 region으로 매핑.

**수정:** `ENTITY_TARGET_TYPE_MAP`을 Epic 2 §8 시나리오 정의에 맞춤

**재현:** `run-offline-eval.ts:106-116` 확인

---

### RC-03: Injection 우회 — 3개 use case에 sanitizer 미적용

**Root cause:** `QuerySanitizer`/`LLMInjectionJudge`가 `SearchUseCase`에만 배선. `HybridUseCase`, `InterpretUseCase`, `ResolveUseCase`는 무방비.

**파생 증상:**
- ~~G-40~~ `/v1/search/hybrid`, `/v1/interpret`, `/v1/entity/resolve`로 injection 우회
- ~~G-42~~ `/v1/search/hybrid` vs `/v1/search?mode=hybrid` 파이프라인 불일치 (resolver skip 포함)

**수정 방향:** use case별 복붙이 아니라, Fastify preParsing hook 또는 base use case에 cross-cutting sanitization layer 추가

**재현:** `rg "querySanitizer" src/application/search/hybrid.usecase.ts` → 0건

---

### RC-04: `npm run eval` 깨짐 — 엔트리 파일 부재

**Root cause:** `package.json`의 `"eval"` 스크립트가 `scripts/run-eval.ts`를 가리키지만 파일 없음.

**수정:** `scripts/eval/run-eval-and-train-ltr.ts` 또는 `run-offline-eval.ts`로 경로 수정

**재현:** `ls scripts/run-eval.ts` → No such file

---

### RC-05: Query length 계약 불일치 (2000 vs 500)

**Root cause:** HTTP Zod 스키마(`query.max(2000)`)와 `QuerySanitizer`(`MAX_LENGTH=500`) 사이 계약 미합의. 단일 source of truth 없음.

**파생:** ~~G-48~~ OpenAPI 스키마 없음도 같은 "계약 미정의" root cause

**수정:** 한쪽으로 통일 + OpenAPI spec 생성으로 계약 확정

---

## P1 — 기능/파이프라인 갭

### RC-06: Watchlist 전체가 프로토타입 상태 (6건 → 1건)

**Root cause:** Watchlist가 route/infra adapter/test만 존재. 실제 DB 마이그레이션, Redis subscriber 시작, pub/sub 배선, ID 타입 통일 전부 미완성.

**통합된 기존 항목:**
- ~~G-23/G-51~~ UUID vs nanoid ID 불일치
- ~~G-24/G-54~~ Redis subscriber 미기동 + lifecycle 없음
- ~~G-49~~ 인메모리 CRUD (DB 우회)
- ~~G-50~~ async delivery 미배선
- ~~G-52~~ route/container 계약 충돌
- ~~G-53~~ response/error schema 미사용
- ~~BACKLOG 34, 35, 41, 42, 44~~ 전부 동일 feature

**수정:** Watchlist를 하나의 epic으로 재설계하거나, 프로토타입 코드 제거

---

### RC-07: Drinking Window 전체가 스텁 (4건 → 1건)

**Root cause:** ML 모델 미학습/미배포. 하위 의존(NL 매핑, ONNX 추론, Claude tool, 플랜 경로)이 전부 스텁.

**통합된 기존 항목:**
- ~~G-25~~ `drinking_window_now` NL 매핑 없음
- ~~G-27/G-45~~ ONNX TODO + 플랜 경로 불일치
- ~~G-28~~ Claude `check_drinking_window` placeholder

**수정:** 모델 학습 후 배포하면 하위 스텁 전부 해소

---

### RC-08: Epic 13/14 핵심 기능 미구현

**별개 root cause이지만 모두 "플랜에 있고 코드에 없음":**

| 항목 | 설명 | 재현 |
|------|------|------|
| ~~G-10~~ ConstraintSAT | planner 직후 하드 제약 모순 검사 미구현 | `rg "ConstraintSAT" src` → 0건 |
| ~~G-11~~ Entropy AbstainPolicy | 엔트로피 기반 기각 정책 미구현 | `rg "entropy" src/domain/decision` → 0건 |
| ~~G-38~~ LLM Decomposer | `LLMDecomposerPort` 미구현 (플랜 폴백) | `rg "llm-decomposer" src` → 0건 |
| ~~G-39~~ BK-tree + Soundex | 별칭 통합 점수 미구현 | 해당 파일 없음 |
| ~~G-12~~ `retrieval_mode` 응답 필드 | `SearchResponseV1`/`EngineDecision`에 없음 | `rg "retrieval_mode_source" src` → 0건 |

---

### RC-09: Wine Attribute Encoder 이중 정의

**Root cause:** `src/domain/`에 `wine-attribute-encoder.ts`(사용처 0건)와 `src/infrastructure/ml/label-encoder.ts`가 동일 역할. Ranker가 infra를 직접 import (DIP 위반).

**파생:** ~~G-20~~ dead code, ~~G-49~~ domain→infra 역참조

**수정:** domain port 정의 → infra adapter 배선. 죽은 코드 삭제.

---

### RC-10: Pairing/Attribute 매핑 미완성

**Root cause:** ETL 스크립트에만 사용되고 런타임 검색 경로에 미배선.

- ~~G-13~~ `extractPairingConstraint` 미import
- ~~G-14~~ `mapping.ts`에 `critic_proxy`/`pairing_tags` 등 미매핑
- ~~G-18~~ `parsedConstraints.unparsed` 항상 빈 배열

**재현:** `rg "extractPairingConstraint" src --glob '*.ts'` → 정의 파일만

---

## P2 — 문서/운영/정리

### RC-11: ESLint/CI 게이트 깨짐

**Root cause:** 린트 214건 에러 상태에서 CI가 lint를 돌리면 항상 실패.

**파생:**
- ~~G-06~~ CI lint 전체 실패
- ~~G-07~~ `test-search-direct.ts` ESLint project 밖
- ~~G-21/G-22~~ `verify-splits` CI 미연동

**수정:** lint 에러 수정 + CI 워크플로에 lint/verify-splits 추가

---

### RC-12: 계약/스키마 부재

**Root cause:** OpenAPI spec 없음, Fastify route에 schema 등록 거의 없음, HTTP 계약이 코드에만 존재.

**통합된 기존 항목:**
- ~~G-48~~ OpenAPI/Swagger 없음
- ~~G-46~~ CORS 미설정
- ~~G-47~~ `HTTP_RATE_LIMIT_MAX=0`이면 rate limit 해제
- ~~G-43~~ `/v1/entity/resolve` requestId 미전달
- ~~G-15/G-16/G-17~~ 배치 응답 계약 (failed=succeeded 집계, injection=200, fail_fast 의미)
- ~~G-41~~ `missingInformation` 필드 부재

---

### RC-13: Epic 4 문서 경로 불일치

**Root cause:** 플랜 문서는 Python/LightGBM 경로를 기술하지만 실제 구현은 TypeScript LambdaMART.

- ~~G-19~~ 문서 경로 vs 실제 파일
- ~~G-35~~ Vespa `ltr_v1`/second-phase 없음 (앱 LTR만)
- ~~G-36~~ `tsconfig.build` LTR exclude

**수정:** 플랜 문서를 실제 구현에 맞게 갱신

---

### RC-14: 플랜 문서 체크리스트 미갱신

**Root cause:** 코드 배포 시 `docs/plans/` 체크리스트를 업데이트하는 프로세스 없음.

- ~~G-55 (첫 번째)~~ Epic 1/2/6/9 deliverables가 `- [ ]`만 남음
- ~~PLANS-GAP-AUDIT §5차 패스~~ 4개 에픽에서 drift 발견

**수정:** 프로세스: PR 머지 시 관련 플랜 `- [ ]` → `- [x]` 갱신 의무화

---

### RC-15: 런타임 인프라 설계 모호

**Root cause:** PG pool이 optional 설계인데 사실상 필수. stub이 프로덕션과 동작 차이 큼.

- ~~G-37~~ PG 미연결 시 광범위 stub
- ~~G-55 (두 번째)~~ `main.ts`가 항상 PG pool 강제 생성
- ~~G-56 (두 번째)~~ `/ready`가 dependency 무관 항상 `ready:true`
- ~~G-54 (두 번째)~~ `createServer()`가 전역 `config` singleton 직접 의존
- ~~G-29~~ 캐시 경로 비활성
- ~~G-30~~ `LLMInjectionJudge` fail-open

**수정:** stub fallback 전략 명문화. health check에 PG/Redis/Vespa liveness 반영.

---

## 기존 파일 → 이 문서 매핑

| 기존 파일 | 상태 | 사유 |
|-----------|------|------|
| `BACKLOG.md` (44항목) | 아카이브 | RC-01~15로 통합됨 |
| `TASKS.md` (A~N 섹션) | 아카이브 | RC별 "수정" 항에 흡수 |
| `GAPS.md` (G-01~G-59) | 아카이브 | RC별 ~~취소선~~으로 매핑 |
| `FINDINGS-MATRIX.md` (M-01~M-38) | 아카이브 | 재현 커맨드는 각 RC에 포함 |
| `AUDIT-LOG.md` | 아카이브 | 검증 스냅샷만 상단에 유지 |
| `AUDIT-SNAPSHOT.md` | **삭제 가능** | FINDINGS-MATRIX의 순수 중복 |
| `PLANS-GAP-AUDIT.md` | 아카이브 | RC-13, RC-14로 흡수 |
| `README.md` | **대체됨** | 이 파일이 새 진입점 |
| `bugbash-apr-6` | **삭제 가능** | 빈 마커 파일 |

---

## 우선순위 요약

| 순위 | RC | 한 줄 | 기존 G-ID 수 |
|------|-----|-------|-------------|
| **P0** | RC-01 | Planner 3개 모드 미반환 → Browse/Compare/Grouper 전부 죽음 | 5 |
| **P0** | RC-02 | Eval 시나리오 매핑 오류 | 1 |
| **P0** | RC-03 | Injection 우회 (3개 use case) | 2 |
| **P0** | RC-04 | `npm run eval` 깨짐 | 1 |
| **P0** | RC-05 | Query length 2000 vs 500 | 2 |
| **P1** | RC-06 | Watchlist 전체 프로토타입 | 7 |
| **P1** | RC-07 | Drinking Window 전체 스텁 | 4 |
| **P1** | RC-08 | Epic 13/14 핵심 미구현 | 5 |
| **P1** | RC-09 | Encoder 이중 정의 + DIP 위반 | 2 |
| **P1** | RC-10 | Pairing/Attribute 런타임 미배선 | 3 |
| **P2** | RC-11 | ESLint/CI 깨짐 | 4 |
| **P2** | RC-12 | 계약/스키마 부재 | 7 |
| **P2** | RC-13 | Epic 4 문서 경로 불일치 | 3 |
| **P2** | RC-14 | 플랜 체크리스트 drift | 2 |
| **P2** | RC-15 | 런타임 인프라 설계 모호 | 6 |
| | | **합계** | **54** |

> 기존 8개 파일, G-ID 59건, BACKLOG 44항목, TASKS A~N → **RC 15건**으로 통합.
