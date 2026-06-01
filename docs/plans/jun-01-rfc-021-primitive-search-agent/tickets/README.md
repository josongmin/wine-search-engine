# Jun 1 RFC-021 Tickets

> 목적: [RFC-021](../../../rfc/RFC-021-primitive-search-and-agent-orchestration.md)를 바로 구현 가능한 작업 티켓으로 분해한다.

## 필수 읽기

1. [../../../rfc/RFC-021-primitive-search-and-agent-orchestration.md](../../../rfc/RFC-021-primitive-search-and-agent-orchestration.md)
2. [../../may-29-interface-revamp/tickets/T-IR-01-primitive-search-and-lookup-contract-split.md](../../may-29-interface-revamp/tickets/T-IR-01-primitive-search-and-lookup-contract-split.md)
3. [../../may-29-interface-revamp/tickets/T-IR-05-agent-runtime-tool-taxonomy-realignment.md](../../may-29-interface-revamp/tickets/T-IR-05-agent-runtime-tool-taxonomy-realignment.md)
4. [../../../../CLAUDE.md](../../../../CLAUDE.md)
5. [../../../../AGENTS.md](../../../../AGENTS.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-PSA-01` | deterministic reference-similarity primitive | implemented | 없음 | `similar_to_entity(entity_id, ...)` internal primitive |
| `T-PSA-02` | agent primitive composition cutover | implemented | `T-PSA-01` | `lookup_wine -> similar_to_entity` agent flow |
| `T-PSA-03` | public search path authority and planner scope reduction | implemented | `T-PSA-01` | primitive route lane authority hardening |
| `T-PSA-04` | reference-similarity eval, golden queries, observability | implemented | `T-PSA-01`, `T-PSA-02`, `T-PSA-03` | regression corpus + trace/eval rails |
| `T-PSA-05` | legacy mixed-surface purge and proof rails | implemented | `T-PSA-02`, `T-PSA-03`, `T-PSA-04` | banned surface guard + closeout matrix |

## Wave

### Wave 1

- [T-PSA-01](./T-PSA-01-deterministic-reference-similarity-primitive.md)

### Wave 2

- [T-PSA-02](./T-PSA-02-agent-primitive-composition-cutover.md)
- [T-PSA-03](./T-PSA-03-public-search-path-authority-and-planner-scope-reduction.md)

### Wave 3

- [T-PSA-04](./T-PSA-04-reference-similarity-eval-golden-queries-and-observability.md)

### Wave 4

- [T-PSA-05](./T-PSA-05-legacy-mixed-surface-purge-and-proof-rails.md)

## 병렬성 규칙

1. `T-PSA-01` 없이는 나머지 티켓이 owner seam 없이 흔들린다.
2. `T-PSA-02`와 `T-PSA-03`은 `T-PSA-01` 이후 병렬 가능하다.
3. `T-PSA-04`는 primitive contract와 public/agent seam이 고정된 뒤에만 한다.
4. `T-PSA-05`는 마지막 closeout 전용이다.

## 공통 금지사항

1. heuristic fallback 추가 금지
2. free-text anchor를 다시 similarity primitive 입력으로 받는 것 금지
3. ranking truth를 prompt/prompt-output parsing에 밀어 넣는 것 금지
4. public search를 agentic behavior로 drift시키는 것 금지
5. `mixed` / `similar_items`를 새 primary product surface로 승격하는 것 금지
6. wrapper를 한 겹 더 씌워 owner seam을 흐리는 것 금지

## 공통 owning seam 규칙

1. search core 티켓이면 `src/application/search/**`, `src/domain/retrieval/**`, `src/domain/ranking/**` 안에서 닫아야 한다.
2. agent 티켓이면 `src/application/wine-search/**`, `src/application/agent/**`, `src/interface/claude-tools/**` 안에서 닫아야 한다.
3. public-search 티켓이면 `src/interface/http/routes/**`, `src/application/search/**`, `src/domain/query/service/**` 안에서 닫아야 한다.
4. eval/trace 티켓이면 `data/**`, `test/**`, `src/domain/query/model/**`, `src/application/search/**` 안에서 닫아야 한다.
5. closeout 티켓은 public/tool/docs/tests surface purge가 목적이지, core algorithm 재작성 티켓이 아니다.

## 공통 건드리지 말아야 할 것

1. unrelated deploy/runtime infra
   - `scripts/deploy/**`
   - `docs/runbook-aws-cli-direct-deploy.md`
   - `docs/runbook-dedicated-app-host-deploy.md`
2. unrelated ETL/snapshot publish path
   - `scripts/etl/**`
   - `tools/**`
3. unrelated web UI styling/UX
   - `web/**`는 해당 티켓에 명시된 경우만 수정
4. repo-wide benchmark framework 전체 재작성
5. Vespa schema/ETL contract 재설계

## 작업자용 최소 보고 포맷

완료 보고는 최소 아래를 분리해야 한다.

1. owner-local green
2. 미실행 rail
3. 의도적으로 안 건드린 레이어
4. 남은 compatibility residue

`대충 다 됨` 식 보고 금지.

## 작업자 체크리스트

착수 전:

1. 선행 티켓 상태 확인
2. 수정 surface가 public HTTP인지, agent runtime인지, search core인지 먼저 분리
3. 기존 `lookup_wine` path-authority 구현을 읽고 동일 패턴 재사용 여부 확인

구현 중:

1. primitive input authority가 `query`인지 `entity_id`인지 명확히 유지
2. planner가 lane authority를 뺏지 못하는지 확인
3. agent trace에서 실제 primitive chain이 보이는지 확인

완료 전:

1. 티켓 문서의 검증 명령 실행
2. banned surface grep 또는 allowlist rail 확인
3. owner-local green과 ambient repo red를 분리해서 보고
4. 자신이 안 건드리기로 한 파일/레이어가 실제로 untouched인지 확인

## 티켓 목록

- [T-PSA-01 Deterministic Reference-Similarity Primitive](./T-PSA-01-deterministic-reference-similarity-primitive.md)
- [T-PSA-02 Agent Primitive Composition Cutover](./T-PSA-02-agent-primitive-composition-cutover.md)
- [T-PSA-03 Public Search Path Authority And Planner Scope Reduction](./T-PSA-03-public-search-path-authority-and-planner-scope-reduction.md)
- [T-PSA-04 Reference-Similarity Eval, Golden Queries, And Observability](./T-PSA-04-reference-similarity-eval-golden-queries-and-observability.md)
- [T-PSA-05 Legacy Mixed-Surface Purge And Proof Rails](./T-PSA-05-legacy-mixed-surface-purge-and-proof-rails.md)
