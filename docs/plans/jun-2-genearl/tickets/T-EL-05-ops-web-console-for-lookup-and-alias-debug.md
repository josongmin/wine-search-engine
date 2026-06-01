# T-EL-05 Ops Web Console For Lookup And Alias Debug

## 목표

CLI/JSON 없이도 operator가 lookup failure를 triage할 수 있도록, trusted ops API 위에 read-only 웹 콘솔을 추가한다.

## 현재 근거

- web app에는 ops 전용 콘솔은 없고 product/search/lab UI만 있다:
  - [web/src/app/search/page.tsx](../../../../web/src/app/search/page.tsx)
  - [web/src/app/wine-search-lab/page.tsx](../../../../web/src/app/wine-search-lab/page.tsx)
- `wine-search-lab`는 trace view/step list를 보여주는 패턴을 이미 가진다: [web/src/features/wine-search-lab/ui/wine-search-view.tsx](../../../../web/src/features/wine-search-lab/ui/wine-search-view.tsx)
- operator가 현재는 curl/SQL/JSONL/runbook을 병행해야 한다.

## 선행 티켓

- [T-EL-04](./T-EL-04-operator-debug-api-and-runtime-observability.md)

## 정확한 산출물

1. read-only ops page:
   - query input
   - admission verdict
   - alias hit table
   - candidate score table
   - final decision + reason
   - snapshot alias health card
2. side-by-side compare:
   - lookup debug
   - public lookup result
   - public hybrid fallback result
3. operator auth/session handling

## 반드시 건드릴 파일

1. `web/src/app/ops/entity-lookup/page.tsx`
2. `web/src/shared/api/client.ts`
3. `web/src/shared/api/types.ts`
4. `web/src/features/wine-search-lab/ui/wine-search-view.tsx`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `web/src/app/search/**`
2. `web/src/app/explore/**`
3. backend runtime logic

## 구현 범위

1. ops route entry
2. trusted API client
3. read-only debug/audit panels
4. compare view
5. error/empty/loading states

## 구현 제외 범위

1. write-plane mutation UI
2. public search redesign
3. mobile-first consumer UX polishing

## 구조 규칙

1. ops console은 product search UI에 섞지 않는다.
2. data truth는 `T-EL-04` ops API contract가 authority다.
3. operator가 score breakdown을 raw JSON 없이 읽을 수 있어야 한다.

## 절대 하지 말아야 할 구현

1. browser local state만으로 alias 수정 후보를 저장하는 것
2. product search page에 admin drawer를 숨겨 넣는 것
3. ops API raw dump를 그대로 textarea로 보여주고 끝내는 것

## 실패 패턴

1. operator가 여전히 curl/SQL이 더 빠른 상태
2. compare panel이 public/product payload와 ops payload를 섞어 오해를 만든다
3. auth/session guard가 없어 일반 사용자에게 노출된다

## 검증 명령

```bash
pnpm --dir web test
pnpm --dir web lint
```

## DoD

1. operator가 브라우저에서 lookup failure class를 triage할 수 있다.
2. public product UI와 분리된 ops route가 존재한다.
3. debug/audit payload를 human-readable view-model로 소비한다.
