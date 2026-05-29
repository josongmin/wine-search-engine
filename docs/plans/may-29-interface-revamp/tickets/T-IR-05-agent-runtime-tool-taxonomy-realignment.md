# T-IR-05 Agent Runtime Tool Taxonomy Realignment

## 목표

agent 내부 tool/runtime taxonomy를 external primitive taxonomy에 맞추고, active tool surface를 4개 primitive로 축소한다.

## 현재 근거

- active tool bundle이 `search_wines` 하나에 `mode`를 태운다: [src/application/wine-search/wine-agent-loop-tool-bundle.ts](../../../../src/application/wine-search/wine-agent-loop-tool-bundle.ts#L88-L152)
- active tool set에 `get_food_pairings`, `check_drinking_window`, `compare_wines`가 포함돼 있다: [src/application/wine-search/wine-agent-loop-tool-bundle.ts](../../../../src/application/wine-search/wine-agent-loop-tool-bundle.ts#L226-L283)
- tool executor dispatch도 같은 taxonomy를 강제한다: [src/interface/claude-tools/tool-executor.ts](../../../../src/interface/claude-tools/tool-executor.ts#L182-L214)

## 선행 티켓

- [T-IR-01](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03](./T-IR-03-agent-session-store-and-history-custody.md)

## 정확한 산출물

1. active tool set:
   - `search_hybrid`
   - `search_semantic`
   - `search_lexical`
   - `lookup_wine`
2. `search_wines(mode=...)` 제거
3. `get_food_pairings`, `check_drinking_window`, `compare_wines` active loop 제거
4. tool executor와 request adapter를 primitive별 typed request로 분리
5. orchestrator/tool trace가 primitive 이름만 surface하도록 정리

## 예상 수정 파일

```text
src/application/wine-search/wine-agent-loop-tool-bundle.ts
src/application/wine-search/wine-agent-loop-schemas.ts
src/application/wine-search/wine-agent-loop.ts
src/application/wine-search/tool-input-normalizer.ts

src/application/search/agent-tool-request-adapter.ts
src/application/search/search-tool-contract.ts
src/application/search/tool-execution-support.ts

src/interface/claude-tools/tool-executor.ts

src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts
src/application/wine-search/__tests__/wine-agent-loop.test.ts
src/application/wine-search/__tests__/tool-input-normalizer.test.ts
src/config/__tests__/wine-search-tool-bundle-wiring.test.ts
```

## 구현 범위

1. tool definition split
2. tool input schema split
3. executor dispatch split
4. runtime wiring 정렬
5. tool trace/output naming 정렬

## 구현 제외 범위

1. HTTP route split
2. CLI UX
3. web/eval/doc cutover

## 구조 규칙

1. internal tool name은 external primitive taxonomy를 직접 반영한다.
2. active loop는 primitive retrieval tool만 가진다.
3. domain convenience tool은 active loop 밖으로 밀어낸다.
4. tool input에서 retrieval selector를 또 받지 않는다.

## 구현 순서

1. new primitive tool defs 추가
2. executor/request adapter 분리
3. old tool defs 제거
4. orchestration tests 갱신

## 금지사항

1. `search_hybrid`가 내부에서 다시 `mode=hybrid`로 `search_wines`를 우회 호출하는 것 금지
2. `compare_wines` 같은 convenience tool을 active agent loop에 유지하는 것 금지
3. history-dependent behavior를 tool 이름 재해석으로 숨기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts src/application/wine-search/__tests__/wine-agent-loop.test.ts src/application/wine-search/__tests__/tool-input-normalizer.test.ts src/config/__tests__/wine-search-tool-bundle-wiring.test.ts
pnpm exec vitest run src/interface/claude-tools/__tests__/tool-executor.test.ts
```

## DoD

1. active agent tool set이 4 primitive tool만 가진다.
2. `search_wines(mode=...)`가 사라진다.
3. tool executor와 trace naming이 external primitive taxonomy와 일치한다.
4. convenience tool 제거 후에도 orchestrator proof rail이 green이다.
