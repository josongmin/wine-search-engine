# EPIC-0 Program Map

## 문제 정의

이번 보드의 핵심은 "버그를 개별 패치로 막는 것"이 아니라, 파이프라인 전체의 실패 의미를 재정렬하는 것이다. 지금 남은 빵꾸는 대부분 로직 부족보다 계약 drift에서 온다.

- compiled-first runtime인데 일부 seam은 여전히 legacy fallback을 품고 있다.
- retrieval / ranking / decision / publish가 각자 다른 failure semantics를 쓴다.
- corrupted 또는 unknown 입력이 empty/neutral/fallback 정상값처럼 위장되는 read path가 남아 있다.
- data-plane에 노출된 필드 중 일부는 writer/provenance 없이 선언만 남아 있거나, fabricated 값으로 채워져 있다.
- snapshot exactness와 public id authority가 분리돼 있지 않아 "복구 성공"과 "식별자 안정성"이 같은 뜻이 아니다.
- API / audit / web client / replay harness가 서로 다른 contract drift를 품으면, backend invariant를 닫아도 사용자 surface에서 다시 의미가 틀어진다.

## 현재 코드 근거

- structured filter merge 후 `plan`과 `compiled`를 같이 갱신하는 흐름이 이미 핵심 축이다: [search-usecase-pre-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts:181>)
- route resolution은 compiled execution contract를 우선 본다: [search-usecase-route-resolution.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-resolution.ts:7>)
- response에는 execution contract projection이 이미 존재한다: [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:99>)
- decision external contract는 route / plannerSuggestedMode를 표면화한다: [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:14>)

## canonical invariant

| invariant | 의미 | 위반 예시 |
|---|---|---|
| `compiled-first` | production runtime은 compiled execution만 신뢰 | `compileFromLegacyPlan()` 재유도 |
| `fail-closed` | unknown/corrupt/partial 상태는 loud failure | unknown channel -> sparse fallback |
| `provenance-closed` | gate/decision은 policy-observed-missing으로 설명 가능 | evidence gate가 constraint 누락을 추적 못함 |
| `signal-not-authority` | retrieval/ranking/resolver 점수는 authority 아님 | rerank failure 후 정상 ranking처럼 응답 |
| `no-partial-publish` | ETL/publish/backfill partial success 금지 | partial output write 후 success exit |
| `artifact-exact` | build/publish/rollback은 동일 artifact를 승격·재생해야 함 | raw silver 재인덱싱으로 rollback |
| `unsupported-is-absent` | provenance 없는 필드는 omit가 정식 동작 | soilType/producerType를 empty/default로 노출 |
| `public-id-immutable` | runtime public id는 overlay/fixture로 변하지 않음 | gold overlay가 public id를 재배정 |
| `surface-aligned` | API/audit/web/replay가 같은 response execution semantics를 공유 | UI는 search happy-path 가정, API는 comparison union 반환 |

## 금지 규칙

1. unknown input을 canonical lexical/semantic channel로 강제하지 않는다.
2. missing evidence를 neutral confidence, empty array, empty object로 위장하지 않는다.
3. prod path에서 in-memory default나 heuristic compile fallback으로 계속 진행하지 않는다.
4. exact/entity route에서 partial hydration을 허용하지 않는다.
5. debug/audit trace와 response/meta vocabulary를 분리된 ad hoc 문자열로 늘리지 않는다.
6. authoritative writer가 없는 필드를 empty/default/fabricated 값으로 승격하지 않는다.
7. rollback/replay는 exact promoted artifact가 아닌 현재 코드 재해석으로 수행하지 않는다.
8. gold fixture나 benchmark linkage가 runtime public id authority를 덮어쓰지 않는다.
9. public API와 client/replay harness는 server contract와 다른 query/result semantics를 독자 해석하지 않는다.

## Failure Taxonomy

| bucket | 설명 | 대표 위치 |
|---|---|---|
| `contract_drift` | type/enum/schema가 SSOT와 어긋남 | retrieval channel, retrieval mode |
| `silent_corruption` | malformed/corrupt input을 empty/default로 위장 | JSONB parse, threshold fallback |
| `partial_success` | 일부 실패 상태를 artifact success로 배출 | backfill, publish, resolver hydration |
| `trace_gap` | failure는 났는데 왜 났는지 policy 기준으로 재현 불가 | resolver candidate trace, decision gate trace |
| `authority_leak` | signal이 authority처럼 외부에 표면화 | rerank failure masking, neutral confidence masking |
| `data_plane_gap` | retrieval/public contract는 읽는데 writer/provenance가 없음 | occasion, soilType, producerType |
| `identity_drift` | 동일 identity가 snapshot/gold overlay에 따라 다른 public id를 가짐 | canonical entity remap 충돌 |
| `surface_drift` | server contract와 client/replay/debug surface의 의미가 어긋남 | comparison union, explain 기본 on, URL/input drift |

## 문서 계약

이번 보드의 모든 에픽 문서는 아래 섹션을 반드시 가진다.

1. 문제 정의
2. 현재 코드 근거
3. 목표 불변식
4. breaking changes
5. 구현 작업 목록
6. 테스트 / 게이트
7. merge 조건

## merge 조건

- 이후 에픽 문서는 이 페이지의 invariant와 taxonomy 용어를 그대로 사용한다.
- 새 ad hoc reason code나 trace field를 만들면 안 된다.
- 모든 에픽은 여기의 invariant 중 어느 것을 닫는지 명시해야 한다.
- data-plane completeness와 public id authority도 contract 문제로 취급하며, 별도 "나중에 데이터 넣자"류의 회피 문구로 빼지 않는다.
