# T-EL-03 Alias Substrate Governance And Hot-Entity Coverage

## 목표

top traffic entity alias hole을 runtime incident가 아니라 managed substrate 문제로 다루기 위해, alias generation/curation/publish/coverage audit를 운영 가능한 체계로 고정한다.

## 현재 근거

- alias generation ETL은 이미 존재한다:
  - [scripts/etl/generate-aliases.ts](../../../../scripts/etl/generate-aliases.ts)
  - [scripts/etl/generate-korean-aliases.ts](../../../../scripts/etl/generate-korean-aliases.ts)
  - [scripts/etl/generate-transliteration-aliases.ts](../../../../scripts/etl/generate-transliteration-aliases.ts)
- publish authority는 `publish-runtime-substrates.ts` 하나다: [test/regression/runtime-plane-insert-authority.regression.test.ts](../../../../test/regression/runtime-plane-insert-authority.regression.test.ts)
- abbreviation alias는 review runbook이 있으나, top entity coverage report나 alias audit surface는 없다: [docs/runbook-abbreviation-aliases.md](../../../../docs/runbook-abbreviation-aliases.md)
- live에서 `dom perignon`, `돔페리뇽`이 lookup 0건이다.

## 선행 티켓

- 없음

## 정확한 산출물

1. hot-entity alias coverage report
2. alias provenance / approval-state inventory
3. curated hole backfill workflow
4. publish 전후 alias diff artifact
5. operator-readable runbook

## 반드시 건드릴 파일

1. `scripts/etl/generate-korean-aliases.ts`
2. `scripts/etl/generate-transliteration-aliases.ts`
3. `scripts/etl/build-search-snapshot.ts`
4. `scripts/etl/publish-runtime-substrates.ts`
5. `scripts/eval/run-noisy-entity-eval.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/domain/resolver/**`
2. `web/**`
3. `src/application/wine-search/**`

## 구현 범위

1. hot entity coverage audit artifact
2. alias hole backfill input/output contract
3. publish diff/report artifact
4. top traffic curated alias lifecycle 문서화

## 구현 제외 범위

1. public route semantics 변경
2. resolver threshold tuning
3. operator web console

## 구조 규칙

1. runtime-plane direct write는 금지다.
2. alias completeness는 ETL/publish/canonical substrate 쪽에서 닫아야 한다.
3. manual curation이 들어가더라도 provenance와 approval state를 남겨야 한다.

## 절대 하지 말아야 할 구현

1. prod DB에 psql 수작업으로 alias row만 추가해 놓고 체계를 닫았다고 주장하는 것
2. generated alias와 curated alias를 provenance 없이 섞는 것
3. hot entity coverage를 문서 수기 목록으로만 관리하는 것

## 실패 패턴

1. alias row는 추가됐지만 next snapshot publish에서 사라짐
2. transliteration alias가 생성되지만 coverage audit에 보이지 않음
3. diff artifact가 없어 retarget/suppression drift를 추적할 수 없음

## 검증 명령

```bash
pnpm run typecheck:etl
pnpm exec tsx scripts/etl/verify-search-snapshot-readiness.ts --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --require-pointer-parity
pnpm exec tsx scripts/eval/run-noisy-entity-eval.ts --smoke-predictions --output /tmp/noisy-entity-results.json
```

## DoD

1. top entity alias hole이 audit artifact에서 바로 보인다.
2. alias backfill이 publish-authority invariant를 지키며 운영된다.
3. alias diff/coverage report가 snapshot publish lifecycle 일부가 된다.
