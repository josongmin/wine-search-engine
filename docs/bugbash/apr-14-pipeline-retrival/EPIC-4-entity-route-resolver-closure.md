# EPIC-4 Entity Route / Resolver Closure

## 문제 정의

entity route는 "exact resolution"인데도, hydration failure / evidence projection / singleton trace가 부족하면 broad retrieval보다 더 위험한 조용한 실패를 만든다. exact/entity path는 partial state를 허용하면 안 된다.

## 현재 코드 근거

- entity candidate hydration은 unresolved IDs를 loud error로 올리는 방향까지 왔다: [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:176>)
- batch fetch와 single fetch reject detail이 error message에 합쳐진다: [search-usecase-resolver-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts:216>)
- resolver는 score/calibration/boundary는 잘 가지지만 per-candidate structured trace는 아직 없다: [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>), [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:291>)
- original bug context는 synthetic entity ranked result가 constraint evidence를 비워 두던 데서 시작됐다: [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:69>)

## 목표 불변식

1. entity route는 partial hydration을 성공으로 돌리지 않는다.
2. resolver는 single candidate exact path를 request trace만으로 재현 가능해야 한다.
3. synthetic ranked result는 fake compatibility shim이 아니라 route-native projection contract를 가진다.
4. singleton/exact invariant는 test + runtime assert + observability event로 고정된다.
5. batch `getDocuments()`는 production entity route의 first-class contract다.

## breaking changes

- entity route에서 document lookup failure는 broad fallback이 아니라 fail-closed 또는 explicit degraded failure가 된다.
- resolver trace는 new structured debug surface를 추가한다.
- entity ranked projection은 generic result mapping과 같은 수준의 evidence/match semantics를 가져야 한다.
- adapter가 batch hydration을 지원하지 않으면 production readiness를 통과하지 못한다.

## 구현 작업 목록

1. `getDocuments()`/`getDocument()` failure taxonomy를 entity route용 loud failure semantics로 정리한다.
2. resolver에 `raw_score`, `calibrated_score`, `threshold`, `ambiguity`, `drop_reason` trace를 추가한다.
3. entity route synthetic ranked result projection을 별도 mapper로 승격한다.
4. singleton candidate가 dropped 되면 invariant violation event를 emit한다.
5. `getDocuments()`를 entity route hard requirement로 승격하고 single-fetch fallback은 test seam으로만 남긴다.

## 테스트 / 게이트

- document hydration partial failure -> entity route explicit failure
- exact singleton route trace snapshot
- entity route + hard constraint -> evidence gate 통과
- invariant violation runtime log test
- batch hydration 미지원 adapter -> readiness 또는 boot-time failure

## merge 조건

- entity exact resolution은 partial hydration/evidence hole을 정상 success로 보이지 않는다.
- production entity route가 batch hydration contract 없이 동작하지 않는다.
