# T-E9-02 Query Contract Parity And Explain Opt-In

## 목표

client query gating과 explain 기본값을 server contract와 맞춘다.

## 현재 근거

- client는 `explain: true`를 기본으로 보낸다: [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:31>)
- client는 `safeQuery.length >= 2`로 독자 gating을 한다: [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:35>)
- search input은 URL을 초기값으로만 읽는다: [search-input.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/ui/search-input.tsx:23>)

## 선행 티켓

- [T-E9-01 comparison-search-union-safe-client](./T-E9-01-comparison-search-union-safe-client.md) 권장

## 정확한 산출물

1. query length gate 제거 또는 서버와 동치인 client contract
2. `explain` opt-in 전환 코드
3. URL/input/query key 동기화 테스트

## 구현 범위

1. explain/debug는 opt-in으로 전환한다.
2. query min-length gating은 server contract와 동일하게 재정의하거나 제거한다.
3. URL/input/query key를 같은 source-of-truth로 재정렬한다.

## 수정 대상 파일

- [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:24>)
- [search-input.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/ui/search-input.tsx:23>)
- 필요 시 web query param helpers / shared API client

## 수정 금지 범위

- backend search API validation 변경
- search page 전체 라우팅 구조 변경
- debug key 정책 변경

## 예상 충돌 파일

- [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:31>)
- [search-input.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/ui/search-input.tsx:23>)
- web search feature tests

## 착수 전 확인

```bash
rg -n "explain: true|length >= 2|useSearchParams|router.push|queryKey" web/src
```

## 구현 단계

1. explain default 값을 제거한다.
2. min-length gating을 서버 계약 기준으로 재정의하거나 제거한다.
3. input state를 URL-driven 또는 sync effect 기반으로 재구성한다.
4. queryKey와 request body가 같은 source-of-truth를 쓰게 맞춘다.

## 작업 중단 조건

1. explain opt-in을 바꾸려면 API consumer 전반의 debug UX 정책을 먼저 정해야 함
2. URL/input drift 수정이 search page state 구조 전체 리팩터로 번짐

## 롤백 기준

- `>= 2` gate를 다른 magic number로만 바꾸는 경우
- explain 기본 on을 유지한 채 조건문만 더 꼬는 경우

## 금지사항

- client-only magic gating 유지 금지
- debug/explain을 query마다 자동 on으로 두지 말 것

## 수용 예시

- 수용:
  - URL `?q=a`면 client는 서버에 동일 query를 보낸다
  - explain은 dev/debug action에서만 켜진다
- 비수용:
  - 화면에 query는 보이는데 network request는 안 나감

## 테스트

- explain default-off test
- 1글자 query parity test
- URL/back-forward/input sync test

## 검증 명령

```bash
pnpm run verify:http-contracts
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] explain default-on 제거
- [ ] 1글자 query gating 제거 또는 server parity 확보
- [ ] URL/input/queryKey drift 재현 케이스 테스트 존재

## 완료 조건

- client가 server semantics와 다른 query contract를 독자 적용하지 않는다.
