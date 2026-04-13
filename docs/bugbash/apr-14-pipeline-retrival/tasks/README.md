# Apr 14 Pipeline Retrival Tasks

> 목적: `apr-14-pipeline-retrival` 보드에서 **실제로 남은 구현분만** 티켓 단위로 잘게 쪼갠 실행 보드.  
> 원칙: 이미 닫힌 축은 재작업 티켓으로 만들지 않는다. `부분 구현` 또는 `미구현` closure만 티켓화한다.

## 상태 요약

| Epic | 상태 | 비고 |
|---|---|---|
| `E1 ETL / Publish` | 부분 구현 | publish/ETL closure verification tasks 추가 |
| `E2 Compiled IR` | 부분 구현 | residual fallback seam 제거 필요 |
| `E3 Retrieval Drift` | 부분 구현 | retrieval attribute/trace closure tasks 추가 |
| `E4 Entity / Resolver` | 부분 구현 | batch hard-requirement, trace, route-native projection 남음 |
| `E5 Provenance / Decision` | 부분 구현 | stable provenance trace, taxonomy, schema 남음 |
| `E6 Ranking / Score` | 부분 구현 | NaN masking, rerank failure contract, score projection 남음 |
| `E7 Corruption / Readiness` | 부분 구현 | JSONB/PG loud failure, threshold/readiness strictness 남음 |
| `E8 Identity / Public ID` | 미구현 | 설계/계약 봉인 필요 |
| `E9 Public Surface / Client` | 미구현에 가까움 | union safety, query contract parity 남음 |
| `E10 Replay / Observability` | 미구현에 가까움 | canonical trace replay/golden 남음 |

## 필수 읽기

티켓 구현 전에 아래 두 문서를 먼저 읽는다.

1. [HANDOFF-RULES.md](./HANDOFF-RULES.md)
2. [TICKET-QUALITY-GATE.md](./TICKET-QUALITY-GATE.md)

이 둘을 안 읽고 바로 티켓에 들어가면 범위를 잘못 넓히거나, silent fallback을 다시 넣거나, 테스트만 맞추는 반쪽 수정이 나오기 쉽다.

## 우선순위 Wave

### Wave 1

- [T-E1-01 etl-stage-ssot-and-partial-success-hard-gates](./T-E1-01-etl-stage-ssot-and-partial-success-hard-gates.md)
- [T-E2-01 remove-residual-compiled-fallback-reads](./T-E2-01-remove-residual-compiled-fallback-reads.md)
- [T-E2-02 compiled-required-post-route-and-ranking-contract](./T-E2-02-compiled-required-post-route-and-ranking-contract.md)
- [T-E3-01 retrieval-guard-trace-vocabulary-ssot](./T-E3-01-retrieval-guard-trace-vocabulary-ssot.md)
- [T-E4-01 entity-route-batch-hydration-hard-requirement](./T-E4-01-entity-route-batch-hydration-hard-requirement.md)
- [T-E5-01 stable-provenance-trace-domain-contract](./T-E5-01-stable-provenance-trace-domain-contract.md)
- [T-E7-01 jsonb-and-entity-row-loud-failure](./T-E7-01-jsonb-and-entity-row-loud-failure.md)

### Wave 2

- [T-E1-02 skip-index-seam-and-etl-data-plane-omit-contract](./T-E1-02-skip-index-seam-and-etl-data-plane-omit-contract.md)
- [T-E3-02 retrieval-facing-attribute-authority-and-omit-contract](./T-E3-02-retrieval-facing-attribute-authority-and-omit-contract.md)
- [T-E4-02 resolver-per-candidate-structured-trace](./T-E4-02-resolver-per-candidate-structured-trace.md)
- [T-E4-03 entity-route-native-ranked-projection](./T-E4-03-entity-route-native-ranked-projection.md)
- [T-E4-04 singleton-drop-invariant-violation-event](./T-E4-04-singleton-drop-invariant-violation-event.md)
- [T-E5-02 unified-provenance-shortfall-taxonomy](./T-E5-02-unified-provenance-shortfall-taxonomy.md)
- [T-E5-04 stitched-regression-for-unified-gate-semantics](./T-E5-04-stitched-regression-for-unified-gate-semantics.md)
- [T-E5-03 typed-audit-extension-and-response-surface](./T-E5-03-typed-audit-extension-and-response-surface.md)
- [T-E6-01 remove-uncertainty-neutral-masking](./T-E6-01-remove-uncertainty-neutral-masking.md)
- [T-E6-04 fused-retrieval-vs-final-ranking-score-vocabulary-split](./T-E6-04-fused-retrieval-vs-final-ranking-score-vocabulary-split.md)
- [T-E6-05 feature-extractor-midpoint-fabrication-removal](./T-E6-05-feature-extractor-midpoint-fabrication-removal.md)
- [T-E7-02 threshold-store-and-readiness-strict-fail-closed](./T-E7-02-threshold-store-and-readiness-strict-fail-closed.md)
- [T-E7-04 vespa-summary-malformed-field-loud-failure](./T-E7-04-vespa-summary-malformed-field-loud-failure.md)

### Wave 3

- [T-E6-02 rerank-normalization-failure-contract](./T-E6-02-rerank-normalization-failure-contract.md)
- [T-E6-03 provenance-consistent-result-score-projection](./T-E6-03-provenance-consistent-result-score-projection.md)
- [T-E7-03 immutable-runtime-substrate-pointer-cutover-design](./T-E7-03-immutable-runtime-substrate-pointer-cutover-design.md)
- [T-E8-01 public-id-immutability-authority-model](./T-E8-01-public-id-immutability-authority-model.md)
- [T-E9-01 comparison-search-union-safe-client](./T-E9-01-comparison-search-union-safe-client.md)
- [T-E9-02 query-contract-parity-and-explain-opt-in](./T-E9-02-query-contract-parity-and-explain-opt-in.md)
- [T-E10-01 representative-replay-corpus-and-golden-trace](./T-E10-01-representative-replay-corpus-and-golden-trace.md)
- [T-E10-02 canonical-shortfall-timeline-observability](./T-E10-02-canonical-shortfall-timeline-observability.md)
- [T-E10-03 release-eval-golden-trace-contract-gate](./T-E10-03-release-eval-golden-trace-contract-gate.md)
- [T-E10-04 replay-triage-playbook-and-ops-doc-linkage](./T-E10-04-replay-triage-playbook-and-ops-doc-linkage.md)

## 작업 규칙

1. 각 티켓은 단독 머지 가능해야 한다.
2. 티켓은 heuristic fallback을 새로 만들면 안 된다.
3. 티켓은 최소 하나 이상의 회귀 테스트 또는 snapshot gate를 추가해야 한다.
4. `response/meta/audit/log` vocabulary를 바꾸면 schema/test/doc까지 같이 닫아야 한다.
5. `prod fail-closed`와 `test seam`은 문서에서 명시적으로 분리해야 한다.

## 티켓 해석 규칙

각 티켓은 아래 순서로 읽고 구현한다.

1. `목표`
2. `현재 근거`
3. `선행 티켓`
4. `정확한 산출물`
5. `수정 대상 파일`
6. `수정 금지 범위`
7. `예상 충돌 파일`
8. `착수 전 확인`
9. `구현 단계`
10. `작업 중단 조건`
11. `롤백 기준`
12. `금지사항`
13. `수용 예시`
14. `테스트`
15. `검증 명령`
16. `머지 전 체크리스트`
17. `완료 조건`

## 구현자 작업 절차

아무 배경지식 없는 작업자도 아래 순서만 따르면 된다.

1. 티켓의 `선행 티켓`이 닫혔는지 확인한다.
2. `정확한 산출물`을 읽고, 이번 티켓에서 남겨야 할 코드/테스트/schema/doc 산출물을 먼저 메모한다.
3. `수정 금지 범위`와 `예상 충돌 파일`을 먼저 읽어 범위 확장을 막는다.
4. `수정 대상 파일`을 위에서부터 순서대로 읽는다.
5. `착수 전 확인`의 grep/테스트를 먼저 실행한다.
6. `구현 단계`를 한 줄씩 순서대로 수행한다.
7. 단계 중 `작업 중단 조건`이 발생하면 즉시 멈추고 티켓 분리 또는 상위 에픽 보강으로 전환한다.
8. 각 단계가 끝나면 최소 관련 테스트를 바로 돌린다.
9. 마지막에 `검증 명령` 전체를 다시 돌린다.
10. `머지 전 체크리스트`를 모두 만족하지 못하면 머지하지 않는다.

## 초심자용 시작 순서

처음 온 작업자는 아래 순서대로만 움직인다.

1. Wave 1 티켓만 본다.
2. 해당 티켓의 `현재 근거` 링크를 먼저 열어 실제 코드 줄을 읽는다.
3. grep 결과가 문서와 다르면 먼저 티켓 문서를 수정한다.
4. 구현 중 범위가 커지면 새 티켓이 필요한지 판단하고, 기존 티켓을 억지로 키우지 않는다.
5. 완료 후에는 다음 티켓으로 넘어가기 전에 README의 상태 표를 갱신한다.

## 공통 검증 명령

기본 타입체크:

```bash
pnpm exec tsc --noEmit --pretty false --incremental false
```

기본 단위 테스트 설정:

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <target-files...>
```

웹 클라이언트/응답 계약을 건드리면 최소 추가:

```bash
pnpm run verify:http-contracts
```

replay/e2e fixture를 건드리면 최소 추가:

```bash
pnpm run test:e2e:replay:fixtures:self-contained
pnpm run test:e2e:contract
```

## 공통 금지사항

1. heuristic fallback 새로 추가 금지
2. unknown/corrupt 값을 empty/default/neutral로 위장 금지
3. test만 녹색으로 만들기 위해 production fail-closed를 약화시키는 수정 금지
4. `as any`, free-form string reason, ad hoc schema 우회 금지
5. 문서/스키마/테스트 중 하나만 수정하는 반쪽 머지 금지
6. 티켓 문서에 없는 설계 확장을 끼워 넣는 "김치 리팩터" 금지

## 비티켓화 축

- `E0`는 프로그램 규칙과 공통 invariant 문서다. 구현 티켓보다는 모든 티켓의 상위 규약으로 유지한다.
