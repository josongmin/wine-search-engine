# T-PSA-02 Agent Primitive Composition Cutover

## 목표

agent가 `"X 비슷한 와인"`과 비교성 질문을 convenience heuristic tool 없이, primitive chain으로 처리하게 전환한다.

## 현재 근거

- active loop는 이미 primitive 중심으로 정리됐지만 `similar_to_entity`는 없다: [src/application/wine-search/wine-agent-loop-tool-bundle.ts](../../../../src/application/wine-search/wine-agent-loop-tool-bundle.ts#L180-L272)
- system/runtime copy는 composition을 primitive로 하라고 말한다: [src/application/wine-search/wine-agent-loop.ts](../../../../src/application/wine-search/wine-agent-loop.ts#L141-L143)
- `compare_wines`는 active tool이 아니지만 unsupported residue와 테스트 잔재가 남아 있다: [src/application/wine-search/__tests__/wine-agent-loop.test.ts](../../../../src/application/wine-search/__tests__/wine-agent-loop.test.ts#L433-L462)

## 선행 티켓

- [T-PSA-01](./T-PSA-01-deterministic-reference-similarity-primitive.md)

## 정확한 산출물

1. active tool set에 `similar_to_entity` 추가
2. agent instruction / tool selection contract:
   - reference similarity는 `lookup_wine -> similar_to_entity`
   - comparison은 `lookup_wine -> lookup_wine -> synthesis`
3. step trace에 primitive invocation chain 노출
4. unsupported legacy compare residue 정리
5. owner-local agent orchestration rail

## 예상 수정 파일

```text
src/application/wine-search/wine-agent-loop-tool-bundle.ts
src/application/wine-search/wine-agent-loop.ts
src/application/wine-search/wine-search-schemas.ts
src/application/wine-search/tool-input-normalizer.ts

src/application/search/search-tool-contract.ts
src/interface/claude-tools/tool-executor.ts
src/domain/agent/model/agent-tool-attempt-schema.ts
src/application/agent/agent-tool-execution-support.ts

src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts
src/application/wine-search/__tests__/wine-agent-loop.test.ts
src/config/__tests__/wine-search-tool-bundle-wiring.test.ts
```

## 반드시 건드릴 파일

1. `src/application/wine-search/wine-agent-loop-tool-bundle.ts`
2. `src/application/wine-search/wine-agent-loop.ts`
3. `src/domain/agent/model/agent-tool-attempt-schema.ts`
4. `src/application/agent/agent-tool-execution-support.ts`
5. `src/application/wine-search/__tests__/wine-agent-loop.test.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/domain/retrieval/**`
2. `src/domain/ranking/**`
3. `src/interface/http/routes/**`
4. `src/domain/query/service/planner*.ts`
5. `data/**`

이 티켓은 agent orchestration 티켓이지, retrieval algorithm/public route/planner ticket이 아니다.

## 구현 범위

1. tool definition / schema 추가
2. runtime prompt/copy/tool selection 규칙 갱신
3. trace/evidence naming 정렬
4. comparison residue 정리
5. orchestration tests 추가

## 구현 제외 범위

1. public HTTP route 추가
2. similarity primitive 자체 구현
3. planner/public-search cleanup

## 구조 규칙

1. agent는 similarity anchor를 직접 텍스트로 넘기지 말고 반드시 `lookup_wine`을 먼저 호출한다.
2. agent는 ranking truth를 설명으로 fabricate하지 말고 primitive 결과를 근거로 합성한다.
3. `compare_wines` convenience tool을 되살리지 않는다.
4. tool trace에는 `lookup_wine`, `similar_to_entity`, `search_*` 같은 실제 primitive 이름만 남긴다.

## 절대 하지 말아야 할 구현

1. prompt만 바꾸고 tool/runtime wire는 그대로 두는 구현
2. `"X 비슷한 와인"`일 때 agent가 문자열 anchor를 직접 `similar_to_entity`에 넣는 구현
3. `compare_wines`를 active loop에 다시 넣는 구현
4. primitive chain을 숨기기 위해 trace/tool attempt schema를 generic 이름으로 뭉개는 구현

## 실패 패턴

1. tool bundle은 바뀌었는데 runtime system prompt는 옛 taxonomy를 말하는 경우
2. compare residue를 "unsupported branch"로만 남겨서 회귀 테스트가 계속 흔들리는 경우
3. agent가 lookup result의 `entity_id` 대신 label string을 재사용하는 경우

## 구현 순서

1. tool bundle/schema에 `similar_to_entity` 추가
2. runtime instruction/copy 수정
3. executor/trace 정렬
4. compare residue 제거
5. orchestration tests 갱신

## 금지사항

1. `"오푸스원 비슷한 와인"`을 다시 `search_hybrid(query="...")` 한 방으로 돌리는 shortcut 금지
2. agent가 `entity_id`를 추측해서 넣는 것 금지
3. legacy `compare_wines` branch를 "temporary compatibility" 명목으로 active path에 남기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/wine-search/__tests__/wine-agent-loop-tool-bundle.test.ts src/application/wine-search/__tests__/wine-agent-loop.test.ts src/config/__tests__/wine-search-tool-bundle-wiring.test.ts
```

## 리뷰어 체크포인트

1. active tool set에 convenience tool이 다시 들어오지 않았는지
2. reference similarity가 실제로 `lookup_wine -> similar_to_entity` chain을 타는지
3. retrieval/ranking core를 불필요하게 건드리지 않았는지
4. trace naming이 primitive taxonomy와 일치하는지

## DoD

1. agent active tool taxonomy가 `similar_to_entity`를 포함한 primitive set으로 닫힌다.
2. reference-similarity 질문이 `lookup_wine -> similar_to_entity` chain으로 실행된다.
3. comparison convenience residue가 active path에서 제거된다.
4. owner-local orchestration rail이 green이다.
