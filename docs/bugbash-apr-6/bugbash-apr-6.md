# Bug bash — `src/application/search` audit

`src/application/search` 하위 **전체 감사** 결과와 **문제점·남은 과제**를 모았다. **`src/application/watchlist`·`src/application/drinking-window` 감사는 §6.**

**범위**: 기본은 `src/application/search/**/*.ts` + 유스케이스 주입 `src/config/container-usecases.ts`. §6은 경계 모듈 보조.

**최종 갱신**: 2026-04-06 (전체 감사 재실행 · 아래 항목 코드와 대조 확인)

**구조**: §3·§6 남은 과제는 **루트 코어스(RC-*, WC-*)** 로 묶음 — 번호(3.1, 6.3…) 나열이 아니라 **원인별 한 방향 액션** 위주.

### 이번 실행에서 확인한 것 (요약)

- **51개** `.ts` 유지; `TODO` / `FIXME` / `console.*` 프로덕션 매치 **없음** (grep).
- **`hybrid.usecase.ts`**: `decomposedSearch` 문자열/참조 **없음** → **RC-B** (라우트 조합 불일치) 여전히 해당.
- **Replay** (`replay.usecase.ts`): `currentSnapshot = buildDecisionSnapshotFromRuntimeVersions(...)`; 비검색 응답은 **`UnexpectedReplayResponseError`** (DomainError).
- **Decomposed / Resolve**: 부모 `context` / `sessionContext` / `queryBudget` 전달과 `Resolve` Constraint SAT fail-fast는 반영됨.
- **스냅샷** (`search-usecase-decision-snapshot.ts`): 런타임 기본 vs 플랜 오버레이 의미 정리는 여전히 **RC-A**.
- **`throw new Error`**: 프로덕션 **`decomposed-search.usecase.ts` 1곳**만.
- **`plan.policy as unknown as`**: `search-usecase-execute-builders.ts` **2곳**.

---

## 1. 감사 요약

| 항목 | 결과 |
|------|------|
| **파일 수** | **51개** `*.ts` (유스케이스, 헬퍼, `port/`, DTO, `__tests__/`) |
| **교차 확인** | `src/config/container-usecases.ts` |
| **자동 검색** | 프로덕션 `*.ts`에서 `TODO` / `FIXME` / `console.(log\|error\|warn\|debug)` — **매치 없음** |
| **테스트 참고** | `src/application/search/__tests__/`, `test/unit/application/search/` |

### 1.1 자동 스캔 스냅샷 (리스크 후보)

| 패턴 | 위치 |
|------|------|
| `plan.policy as unknown as …` | `search-usecase-execute-builders.ts` (2곳) |
| `throw new Error` | **`decomposed-search.usecase.ts` (1곳)** — replay는 DomainError로 대체됨 |
| ` as any` | **테스트만**: `__tests__/search-injection-defense.test.ts` |

### 1.2 파일 인벤토리 (51)

| 구분 | 파일 |
|------|------|
| 유스케이스 | `search`, `hybrid`, `interpret`, `resolve`, `replay`, `decomposed-search`, `batch-search` (`.usecase.ts`) |
| DTO | `search-request`, `hybrid-request`, `interpret-request`, `resolve-request`/`resolve-response`, `replay-request`, `batch-search` (`.dto.ts`) |
| port | `search-pipeline-deps`, `search-executor`, `search-route-usecases` |
| 보안·프리라우트·캐시 | `query-entry-security`, `search-usecase-security-gate`, `search-usecase-pre-route-phase`, `search-usecase-cache-*`, `search-usecase-constraint-*`, `search-usecase-planner-context` |
| 라우트·랭킹·후처리 | `search-usecase-route-*`, `search-usecase-hybrid-*`, `search-usecase-mixed-route`, `search-usecase-post-route-phase`, `search-usecase-ranked-route-resolve`, `search-usecase-resolver-candidates`, `search-usecase-entity-resolver-input`, `search-usecase-ltr-rerank`, `search-usecase-ranking-scores`, `search-usecase-map-result-items`, `search-usecase-execute-builders` |
| 결정·스냅샷 | `search-usecase-decision-input`, `search-usecase-decision-snapshot`, `search-usecase-counterfactuals`, `drinking-window-confidence`, `search-usecase-cache-integration` |
| barrel | `index.ts` |
| `__tests__` | `query-entry-security`, `search-injection-defense`, `specialized-retrieval-routing`, `search-usecase-post-route-phase`, `drinking-window-confidence` |

---

## 2. 해소된 항목 (이전 감사 대비)

### Query-entry 보안 스택 parity (Search / Hybrid / Interpret / Resolve)

- `src/config/container-usecases.ts`에서 공통으로 **`injectionJudge`**, **`judgeFailureMode`**, **`queryEntrySecurityObserver`** (`getQueryEntrySecurityMetricsCollector()`)를 주입한다.
- `InterpretUseCase`, `ResolveUseCase`는 `createSearchQuerySecurityGate`에 위 필드를 전달한다.

### Replay — 비검색 응답 분기

- 비교 응답 등 비정상 케이스는 **`UnexpectedReplayResponseError`** (`DomainError`, 코드 `UNEXPECTED_REPLAY_RESPONSE`)로 처리. 구 `throw new Error(...)` 제거.

---

## 3. 남은 문제점 — 루트 코어스 (patch 스택 쌓지 말 것)

같은 원인에서 나온 증상은 **한 번에 설계로 닫는다.** 아래 네 덩어리가 상위 원인이다.

---

### RC-A — 스냅샷·비교의 **단일 소스 오브 트루스**가 없음

**원인**: “검색 응답에 실린 스냅샷”과 “리플레이가 쓰는 현재 스냅샷”이 **서로 다른 빌더·다른 필드 의미**를 쓰면, 비교·리그레션 의미가 흔들린다.

| 증상 | 정리 |
|------|------|
| Replay vs 검색 | 리플레이는 `buildDecisionSnapshotFromRuntimeVersions`만 → policy/threshold/planner는 `DEFAULT_*`. 검색 쪽은 플랜 오버레이. → `SNAPSHOT_MISMATCH` 과검출 가능 (`replay.usecase.ts`, `search-usecase-decision-snapshot.ts`). |
| `feature_flags` 비교 | `recordsMatch()`가 **얕은** 키/값 비교 — 중첩이 생기면 비교 의미가 깨짐. |

**한 방향 액션**: (1) 비교에 쓰는 스냅샷을 **한 빌더·한 스키마**로 고정하거나 (2) “어떤 필드는 비교 제외”를 **문서·계약**으로 고정. 그 다음에 필요하면 deep compare 등 **구현 한 번**.

**부수**: `plan.policy as unknown as …` (`search-usecase-execute-builders.ts`)는 “트레이스 입력 타입이 없어서” 생긴 것 — 타입 정식화와 **같은 PR에서** 정리하는 게 patch-on-patch를 막는다.

---

### RC-B — **라우트별 유스케이스 조합**이 메인 검색과 어긋남

**원인**: Hybrid / Decomposed / Resolve / Interpret가 **같은 사용자 기대(컨텍스트·제약·기능)**를 공유한다고 가정하지 않고, wiring만 다르게 두면 **제품 단위로 깨진 경험**이 된다.

| 증상 | 정리 |
|------|------|
| Hybrid | `HybridUseCase` pre-route에 **`decomposedSearch` 없음** → 메인과 “비교 분해” 불일치 가능. |
| Interpret | Constraint SAT·캐시 **없음** — “플래너만”이면 의도적일 수 있음. |

**한 방향 액션**: “검색 패밀리”에 대한 **기능 매트릭스**(어떤 라우트에 어떤 게 들어가는지)를 한 번 정하고, 코드는 그 표에 맞춰 **한 번에** wiring·OpenAPI·RFC를 맞춘다.

---

### RC-C — **예외·에러 계약**이 도메인 계층까지 내려오지 않음

**원인**: 비정상 분기가 plain `Error`로 남으면 HTTP 매핑·로깅·클라이언트 처리가 **라우트마다 달라지기 쉽다.**

| 증상 | 정리 |
|------|------|
| Decomposed | `decomposed-search.usecase.ts`에 **`throw new Error(...)` 1곳** 남음 — Replay 쪽은 이미 DomainError로 정리됨. |

**한 방향 액션**: “검색 파이프라인 비정상 응답”에 대한 **소수의 DomainError 코드**를 정하고, 한 번에 승격.

---

### RC-D — **로컬 구현·문서 부채** (위 세 가지와 독립)

| 항목 | 내용 |
|------|------|
| LTR rerank | `search-usecase-ltr-rerank.ts` — `Map` 키 `entityId as string`, 중복 엔티티 엣지 시 보강·테스트. |
| 캐시 가이드 파일 | `search-usecase-cache-integration.ts` — 의사코드 성격; 실제 캐시 경로와 **문서 링크·위치** 정리. |

---

### P3 — 낮은 우선순위 (RC-D에 가깝게 유지)

- **Barrel `index.ts`**: DTO·에러 타입 deep import — 표면 API 정책 문서화.
- **테스트 `as any`**: `__tests__/search-injection-defense.test.ts`.
- **LTR 헬퍼 단위 테스트**: 전용 테스트가 얇으면 회귀 추적 비용 증가 가능.

---

## 4. 긍정적으로 확인된 것

- 프로덕션 `src/application/search/**/*.ts`(테스트 제외)에서 **TODO/FIXME/console 로깅 남발** 패턴은 감사 시 유의미하게 잡히지 않음.
- `dispatchSearchRouteExecution`은 `QueryRoute` 유니온으로 라우트 분기 누락을 타입으로 막기 쉬운 형태.
- `BatchSearchUseCase`는 비교 응답 등 비정상 케이스를 아이템 실패로 매핑하는 등 방어 로직이 있음.
- **Replay** 비검색 응답은 **DomainError** 계열로 정리됨.

---

## 5. 권장 처리 순서 (루트 코어스 기준)

1. **RC-A**: 스냅샷 비교 SSOT 한 번에 고정(또는 비교 제외 필드 문서화) → shallow compare·policy 캐스트는 그 다음에만.
2. **RC-B**: 검색 패밀리 **기능 매트릭스** 확정 → Hybrid / Decomposed / Resolve / Interpret wiring·문서를 한 번에.
3. **RC-C**: decomposed 등 남은 plain `Error` → DomainError 승격을 한 규칙으로.
4. **RC-D**: LTR·캐시 가이드 파일 등 로컬 부채.
5. **§6 WC-A ~ WC-B**: Watchlist **인가 모델** + Drinking window **관측 컨텍스트 SSOT**(한 번에 잡는 게 `targetYear`/critic/실패 노출 패치를 반복하지 않게 함).

---

## 6. `watchlist` / `drinking-window` — 루트 코어스

**최종 갱신**: 2026-04-06

애플리케이션 파일: [watchlist.service.ts](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts) 1개, [drinking-window.usecase.ts](/Users/songmin/wine-search-engine/src/application/drinking-window/drinking-window.usecase.ts) + [port](/Users/songmin/wine-search-engine/src/application/drinking-window/port/drinking-window-usecase.port.ts) 2개. HTTP·검색 연계는 **같은 루트에서 나온 증상**으로 묶음.

---

### WC-A — **식별·인가 모델 부재** (누가 어떤 리소스에 접근하는가)

**원인**: API와 서비스가 “요청자 = 주체”를 전제하지 않고 **id·body만** 본다. 그래서 아래가 **한 줄기**로 이어진다.

| 증상 | 정리 |
|------|------|
| IDOR | [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts) `GET/DELETE/:id`, `.../deliveries` — UUID만 알면 타인 엔트리·배송 로그 접근. [WatchlistService](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)도 소유권 미검증. |
| 임의 `user_id` | `POST` body의 `user_id`가 [스키마](/Users/songmin/wine-search-engine/src/interface/http/schemas/watchlist.schema.ts)상 UUID 형식만 강제 — **인증 subject와 무관**. |
| “내 목록” 불가 | [listByEntityId](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)만 있고 **user 기준 목록·HTTP 없음** — 정상 UX는 결국 **인증 + list**와 같은 설계에서만 나온다. |

**한 방향 액션**: **인증 주체 → 리소스 소유** 규칙을 한 번 정하고, 라우트·스키마·서비스를 그에 맞게 **통째로** 맞춘다(부분 패치로 6.1만 고치지 말 것).

---

### WC-B — Drinking window **관측 컨텍스트 SSOT** 없음 (연도·입력·출력·실패)

**원인**: 검색 후처리·유스케이스·포트가 “같은 의미의 한 순간(연도·점수·피크)”을 **한 객체/한 파이프라인**으로 공유하지 않는다. 증상이 여러 번호로 쪼개져 보일 뿐이다.

| 증상 | 정리 |
|------|------|
| 연도 불일치 | [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)는 `currentYear`로 캐시 행 drinkable을 계산하지만 `check()`에 **`targetYear` 미전달** → [DrinkingWindowUseCase](/Users/songmin/wine-search-engine/src/application/drinking-window/drinking-window.usecase.ts)는 서버 `getFullYear()` 고정. |
| `peakYear` 드롭 | [predictor port](/Users/songmin/wine-search-engine/src/domain/drinking-window/port/drinking-window-predictor.port.ts)에는 있으나 [DrinkingWindowBlock](/Users/songmin/wine-search-engine/src/domain/response/model/result-item.ts)·유스케이스로 안 넘김 — **제품 스키마 결정**이 선행. |
| 입력 중복·시그니처 혼란 | port·use case에 **동일 request 타입 중복**, `check()`는 `Promise`인데 예측은 동기 — 필드 추가 시 **파일 여러 개 패치** 위험. |
| critic 기본 80·실패 무음 | 같은 매퍼에서 `avgCriticProxyScore ?? 80`, `Promise.allSettled`로 **거부 시 블록 생략** — 정책·관측 없이 숫자만 바꾸면 또 패치. |

**한 방향 액션**: “검색 결과에 붙는 drinking window 한 건”에 대해 **입력 DTO(연도·critic·…)** 와 **출력 DTO(peak 포함 여부)** 와 **실패 시 정책(omit vs 오류 vs 메트릭)** 을 한 표로 정한 뒤, 매퍼·`check()`·블록을 **한 번에** 맞춘다.

---

### WC-C — Watchlist **영속 계층 무결성**을 앱이 보장하지 않음

**원인**: 로그·전체 삭제가 “도메인 규칙”이 아니라 **스토리지 편의**에 가깝게 노출됨.

| 증상 | 정리 |
|------|------|
| `recordDeliveryLog` | [WatchlistService](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)가 존재 확인 없이 `append` — FK 없는 저장소에선 고아 로그 가능. |
| `clear()` on port | 운영 서비스 포트에 **전체 삭제** — 테스트/전용 API와 분리 안 하면 오용 위험. |

**한 방향 액션**: 불변식(“로그는 항상 존재하는 watchlist에만”)을 **한 정책**으로 정하고, 앱 vs 인프라 경계를 맞춤.

---

### WC-D — 테스트·스타일

- 앱 디렉터리 **전용 단위 테스트** 부족 — 규칙은 [라우트·predictor 테스트](/Users/songmin/wine-search-engine/src/__tests__/watchlist-routes.test.ts) 등에 분산.
- [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts) 일부 핸들러 **들여쓰기**만 어색(동작 무관).

---

*리팩터링 후 §3·§6를 루트 코어스 기준으로 다시 맞출 것.*
