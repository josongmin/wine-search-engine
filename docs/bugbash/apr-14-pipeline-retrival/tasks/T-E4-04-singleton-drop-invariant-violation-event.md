# T-E4-04 Singleton Drop Invariant Violation Event

## 목표

singleton candidate가 dropped 되는 경우를 invariant violation으로 표면화하고, silent ambiguous/no-match로 넘어가지 못하게 한다.

## 현재 근거

- EPIC-4는 singleton candidate dropped invariant violation event를 요구한다: [EPIC-4-entity-route-resolver-closure.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-4-entity-route-resolver-closure.md:33>)
- 현재 tasks에는 trace, projection, batch hydration은 있지만 invariant event 전용 티켓은 없다.

## 선행 티켓

- [T-E4-02 resolver-per-candidate-structured-trace](./T-E4-02-resolver-per-candidate-structured-trace.md)

## 정확한 산출물

1. singleton-drop invariant detection 코드
2. observability/audit event
3. invariant regression tests

## 구현 범위

1. candidate count와 resolved/ranked count 사이 invariant를 명시한다.
2. singleton candidate가 dropped 되면 explicit event와 reason code를 emit한다.
3. debug/audit trace에서 이 invariant violation을 식별 가능하게 한다.

## 수정 대상 파일

- [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>)
- entity route observability / audit projection
- resolver tests

## 수정 금지 범위

- resolver scoring formula 재튜닝
- decision engine 정책 변경
- entity route projection 재설계

## 예상 충돌 파일

- [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>)
- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- resolver-related tests

## 착수 전 확인

```bash
rg -n "invariant|singleton|candidate_count|ranked_count|resolved_count" src/domain/resolver src/application/search
```

## 구현 단계

1. invariant definition을 먼저 문서/코드 주석으로 고정한다.
2. violation detect 지점을 정한다.
3. event/reason code를 추가한다.
4. violation 재현 테스트를 추가한다.

## 작업 중단 조건

1. violation event를 넣으려면 E5 taxonomy가 먼저 고정돼야 함
2. singleton semantics를 exact entity 외 route에도 확장할지 정책 결정이 필요함

## 롤백 기준

- invariant violation이 여전히 silent ambiguous/no-match로 보이는 경우
- event 없이 log line만 남는 경우

## 금지사항

- violation을 warning-only로 낮추지 말 것
- singleton drop을 정상 ambiguity로 재해석하지 말 것

## 수용 예시

- 수용:
  - singleton candidate dropped -> explicit invariant_violation event
- 비수용:
  - singleton candidate dropped -> 그냥 `ambiguous`

## 테스트

- singleton drop invariant regression
- event emission snapshot

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <resolver-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] singleton drop event 존재
- [ ] silent ambiguity/no-match로 위장되지 않음
- [ ] invariant tests 존재

## 완료 조건

- singleton candidate drop은 정상 search outcome처럼 숨겨지지 않는다.
