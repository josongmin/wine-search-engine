# T-E7-04 Vespa Summary Malformed Field Loud Failure

## 목표

Vespa mapping/from-summary 복원 로직에서 malformed optional field를 quiet omit이나 default로 넘기지 않고 loud failure로 올린다.

## 현재 근거

- EPIC-7은 Vespa mapping/from-summary malformed optional field loud failure를 요구한다: [EPIC-7-corruption-readiness-data-plane.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-7-corruption-readiness-data-plane.md:40>)
- 현재 tasks는 DB read-path corruption과 threshold/readiness는 다루지만, Vespa read-model strictness 전용 티켓은 없다.

## 선행 티켓

- [T-E7-01 jsonb-and-entity-row-loud-failure](./T-E7-01-jsonb-and-entity-row-loud-failure.md) 권장

## 정확한 산출물

1. malformed Vespa summary field loud failure 코드
2. from-summary strict parsing tests
3. read-model corruption taxonomy 연결

## 구현 범위

1. Vespa summary/from-summary mapping이 읽는 optional field inventory를 만든다.
2. malformed field를 silent omit/default로 넘기지 않게 바꾼다.
3. read-model corruption reason code와 연결한다.

## 수정 대상 파일

- [mapping.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/mapping.ts:1>)
- [vespa-search-index.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts:282>)
- Vespa mapping tests

## 수정 금지 범위

- Vespa schema redesign
- search ranking logic 변경
- DB corruption policy 변경

## 예상 충돌 파일

- [mapping.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/mapping.ts:1>)
- [vespa-search-index.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts:282>)
- Vespa adapter tests

## 착수 전 확인

```bash
rg -n "summary|optional|undefined|null|mapping" src/infrastructure/vespa test
```

## 구현 단계

1. summary field inventory를 먼저 만든다.
2. malformed optional field 사례를 분류한다.
3. quiet omit/default 경로를 loud failure로 바꾼다.
4. tests로 malformed summary를 고정한다.

## 작업 중단 조건

1. malformed와 legitimately absent를 구분할 canonical schema가 부족함
2. loud failure가 retrieval broad recall 전반을 과도하게 깨트려 policy 결정이 필요함

## 롤백 기준

- malformed field가 여전히 `undefined`로만 조용히 사라지는 경우
- reason code 없이 adapter exception만 던지고 끝나는 경우

## 금지사항

- malformed field를 empty string/empty array로 보정하지 말 것
- optional absent와 malformed를 같은 취급으로 섞지 말 것

## 수용 예시

- 수용:
  - malformed `producerType` summary -> explicit corruption failure
- 비수용:
  - malformed `producerType` summary -> omitted silently

## 테스트

- Vespa summary malformed field tests
- corruption taxonomy integration tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <vespa-mapping-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] malformed optional field loud failure
- [ ] absent vs malformed 구분
- [ ] tests가 summary corruption을 재현

## 완료 조건

- Vespa read-model corruption이 quiet omit/default로 위장되지 않는다.
