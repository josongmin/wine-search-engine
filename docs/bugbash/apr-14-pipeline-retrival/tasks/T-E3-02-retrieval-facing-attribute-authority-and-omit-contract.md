# T-E3-02 Retrieval-Facing Attribute Authority And Omit Contract

## 목표

retrieval-facing attribute plane에서 canonical vocabulary와 writer provenance를 강제하고, authority 없는 attribute는 omit contract로 정리한다.

## 현재 근거

- EPIC-3은 `occasion`, `priceBand`, `soilType`, `producerType` 같은 retrieval-facing attribute의 canonical vocabulary + writer provenance 점검을 요구한다: [EPIC-3-retrieval-contract-drift.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-3-retrieval-contract-drift.md:39>)
- E1에도 data-plane omit contract 요구가 있어 retrieval과 ETL이 교차한다.

## 선행 티켓

- [T-E1-02 skip-index-seam-and-etl-data-plane-omit-contract](./T-E1-02-skip-index-seam-and-etl-data-plane-omit-contract.md) 권장

## 정확한 산출물

1. retrieval-facing attribute authority inventory
2. unsupported attribute omit contract
3. canonical vocabulary validation tests

## 구현 범위

1. retrieval layer가 읽는 attribute 목록을 inventory로 만든다.
2. 각 attribute의 writer provenance와 canonical vocabulary를 확인한다.
3. authority 없는 attribute는 retrieval builder 단계에서 omit 처리한다.

## 수정 대상 파일

- retrieval attribute builders/services
- candidate constraint evidence and retrieval attribute projection code
- 관련 tests

## 수정 금지 범위

- ETL writer 신규 구현
- ranking feature schema 확대
- client response schema 변경

## 예상 충돌 파일

- [candidate-constraint-evidence.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts:134>)
- retrieval attribute projection/builders
- ETL field mapping docs

## 착수 전 확인

```bash
rg -n "occasion|priceBand|soilType|producerType" src/domain/retrieval src/application/search scripts/etl
```

## 구현 단계

1. attribute inventory 표를 먼저 만든다.
2. writer provenance가 없는 attribute를 분류한다.
3. retrieval builder에서 unsupported attribute를 omit하도록 바꾼다.
4. canonical vocabulary drift를 테스트로 고정한다.

## 작업 중단 조건

1. retrieval builder가 아니라 ETL writer가 먼저 바뀌어야만 판단 가능한 attribute가 많음
2. attribute omit이 아니라 degraded trace가 먼저 필요하다는 정책 결정이 필요함

## 롤백 기준

- unsupported attribute가 retrieval plane에 여전히 남는 경우
- canonical vocabulary 없이 free-form string attribute를 계속 읽는 경우

## 금지사항

- authority 없는 attribute를 fabricated default로 채우지 말 것
- omit contract 없이 "나중에 writer 붙일 예정"이라는 이유로 그대로 두지 말 것

## 수용 예시

- 수용:
  - writer provenance 없는 `producerType` -> retrieval plane omitted
- 비수용:
  - writer provenance 없는 `producerType` -> empty string으로 유지

## 테스트

- retrieval attribute authority inventory tests
- unsupported attribute omit tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <retrieval-attribute-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] attribute inventory가 코드 근거와 맞음
- [ ] authority 없는 attribute omit contract 존재
- [ ] canonical vocabulary drift tests 존재

## 완료 조건

- retrieval layer가 authority 없는 fabricated attribute를 정상 입력으로 읽지 않는다.
