# T-MTA-01 Messages-Native Agent Core And History-Applied Trace

## 목표

agent core를 `query` 중심 입력에서 `messages[]` 중심 입력으로 바꾸고, 실제 planner에 적용된 `history_applied`를 결과 trace에 남긴다.

## 현재 근거

- current `/v1/agent/run` route는 마지막 user message만 뽑아 legacy `query`로 변환한다: [src/interface/http/routes/agent.route.ts](../../../../src/interface/http/routes/agent.route.ts)
- local CLI facade도 같은 legacy adapter를 사용한다: [src/infrastructure/cli/local/local-wine-search-facade.ts](../../../../src/infrastructure/cli/local/local-wine-search-facade.ts)
- orchestrator input은 아직 `query` 중심이다: [src/application/wine-search/wine-search-orchestrator.ts](../../../../src/application/wine-search/wine-search-orchestrator.ts)

## 선행 티켓

없음

## 정확한 산출물

1. orchestrator canonical input
   - `messages`
   - `context?`
   - `options?`
   - `requestId`
   - `abortSignal?`
2. planner/analyzer/loop가 실제 history를 입력으로 받는 path
3. 결과 trace의 `history_applied`
4. legacy `query` adapter 제거

## 예상 수정 파일

```text
src/application/wine-search/wine-search-orchestrator.ts
src/application/wine-search/wine-search-schemas.ts
src/application/wine-search/wine-search-result-schemas.ts
src/application/wine-search/query-analyzer.ts
src/application/wine-search/wine-agent-loop.ts

src/interface/http/routes/agent.route.ts
src/interface/http/routes/wine-search-route-support.ts
src/interface/http/routes/wine-search-response-mapper.ts

src/infrastructure/cli/local/local-wine-search-facade.ts
src/application/cli/dto/wine-search.dto.ts

src/application/wine-search/__tests__/wine-search-orchestrator.test.ts
src/application/wine-search/__tests__/wine-agent-loop.test.ts
test/integration/http/routes/agent.route.test.ts
```

## 구현 범위

1. orchestrator input model 재정의
2. query-analyzer/loop에 messages history 연결
3. `history_applied` response/trace 모델 추가
4. HTTP/local CLI query adapter 제거

## 구현 제외 범위

1. session persistence
2. HTTP session route 등록
3. CLI session UX

## 구조 규칙

1. `single-shot`과 `turnful`은 같은 orchestrator를 쓴다.
2. latest user message는 planner anchor일 뿐 canonical contract가 아니다.
3. prior history는 trace에서 숨기지 않는다.
4. token budget 초과를 hidden truncation으로 덮지 않는다.

## 구현 순서

1. orchestrator input type 재정의
2. route/local facade adapter 제거
3. analyzer/loop wiring 정리
4. result trace에 `history_applied` 추가
5. unit/integration rail 갱신

## 금지사항

1. `messages[]`를 받아 놓고 마지막 user text만 planner에 넘기는 것 금지
2. route에서 prompt stitching을 소유하는 것 금지
3. `history_applied`를 계산만 하고 response에 숨기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/wine-search/__tests__/wine-search-orchestrator.test.ts src/application/wine-search/__tests__/wine-agent-loop.test.ts
pnpm run test:integration:file -- test/integration/http/routes/agent.route.test.ts
```

## DoD

1. canonical agent input이 `messages[]`다.
2. local/HTTP single-shot path에서 legacy `query` adapter가 제거된다.
3. 결과 trace에 `history_applied`가 존재한다.
4. planner가 실제 history를 받는 것이 테스트로 증명된다.
