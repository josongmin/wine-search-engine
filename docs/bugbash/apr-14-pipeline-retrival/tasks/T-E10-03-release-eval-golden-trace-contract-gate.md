# T-E10-03 Release Eval Golden Trace Contract Gate

## 목표

release/eval gate가 golden trace parity와 contract drift를 실제로 검사하도록 연결한다.

## 현재 근거

- EPIC-10은 release/eval gate에 contract drift 검사와 golden trace parity를 추가하라고 요구한다: [EPIC-10-replay-observability-golden-set.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-10-replay-observability-golden-set.md:30>)
- 현재 tasks는 replay corpus와 timeline observability는 다루지만 release/eval gate integration 전용 티켓은 없다.

## 선행 티켓

- [T-E10-01 representative-replay-corpus-and-golden-trace](./T-E10-01-representative-replay-corpus-and-golden-trace.md)
- [T-E10-02 canonical-shortfall-timeline-observability](./T-E10-02-canonical-shortfall-timeline-observability.md)

## 정확한 산출물

1. release/eval gate integration 코드
2. golden trace parity contract test
3. gate failure output 문서

## 구현 범위

1. replay golden trace parity를 release/eval gate에 연결한다.
2. payload drift와 contract drift를 구분해 실패시킨다.
3. gate failure 메시지를 triage 가능하게 정리한다.

## 수정 대상 파일

- eval/release gate scripts
- replay fixture gate tests
- 관련 docs

## 수정 금지 범위

- core search runtime 변경
- replay corpus 내용 변경
- observability schema 재설계

## 예상 충돌 파일

- release/eval gate scripts
- replay golden tests
- bugbash/readme docs

## 착수 전 확인

```bash
rg -n "golden|replay|contract drift|eval|gate" scripts test docs
```

## 구현 단계

1. current release/eval gate entrypoints를 정리한다.
2. golden trace parity 검사 지점을 추가한다.
3. failure output을 contract drift vs payload drift로 분리한다.
4. docs에 triage 예시를 추가한다.

## 작업 중단 조건

1. release/eval gate 체계가 repo 전역 공용이라 별도 팀 정책 결정이 필요함
2. golden trace schema가 아직 안정화되지 않음

## 롤백 기준

- golden set은 돌지만 release/eval gate에 연결되지 않는 경우
- drift 종류를 구분하지 못하고 하나의 generic failure로만 끝나는 경우

## 금지사항

- gate를 advisory-only report로 남기지 말 것
- contract drift를 payload drift에 묻지 말 것

## 수용 예시

- 수용:
  - release gate failure reason: `contract_drift:provenance_trace`
- 비수용:
  - release gate failure reason: `golden failed`

## 테스트

- release/eval gate integration tests
- golden trace contract tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <replay-gate-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] golden trace parity가 release/eval gate에 연결됨
- [ ] contract drift와 payload drift를 구분함
- [ ] triage output 문서화 완료

## 완료 조건

- release/eval 단계에서 golden trace contract drift를 자동으로 차단한다.
