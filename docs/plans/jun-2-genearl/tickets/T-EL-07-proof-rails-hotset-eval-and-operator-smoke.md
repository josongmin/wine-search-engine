# T-EL-07 Proof Rails Hotset Eval And Operator Smoke

## 목표

entity lookup hardening과 ops tooling이 문서상만 닫히지 않도록, hotset regression + operator smoke + closeout matrix를 final gate로 고정한다.

## 현재 근거

- noisy entity eval rail은 이미 있다: [scripts/eval/run-noisy-entity-eval.ts](../../../../scripts/eval/run-noisy-entity-eval.ts)
- `test:verification:noisy`는 존재한다: [package.json](../../../../package.json)
- operator tooling/alias coverage/debug API에 대한 dedicated gate는 아직 없다.

## 선행 티켓

- [T-EL-01](./T-EL-01-lookup-admission-gate-and-query-family-authority.md)
- [T-EL-02](./T-EL-02-resolver-abstain-and-short-noisy-fail-close.md)
- [T-EL-03](./T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)
- [T-EL-04](./T-EL-04-operator-debug-api-and-runtime-observability.md)
- [T-EL-05](./T-EL-05-ops-web-console-for-lookup-and-alias-debug.md)
- [T-EL-06](./T-EL-06-curation-write-plane-for-proposals-ambiguity-and-suppression.md)

## 정확한 산출물

1. entity hotset fixture suite
2. live/operator smoke script
3. closeout matrix
4. banned/allowed residue list

## 반드시 건드릴 파일

1. `scripts/eval/run-noisy-entity-eval.ts`
2. `test/regression/noisy-runtime-execution-contract.regression.test.ts`
3. `docs/runbook-abbreviation-aliases.md`
4. `docs/bench/pr-gate.md`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. core resolver logic
2. web product pages
3. deploy scripts

## 구현 범위

1. hotset fixtures:
   - exact
   - typo
   - transliteration
   - concept-reject
   - ambiguity/clarify
2. operator smoke script for trusted endpoints
3. closeout reporting template

## 구현 제외 범위

1. benchmark framework 전체 재작성
2. unrelated retrieval perf tuning

## 구조 규칙

1. gate는 owner-local green과 live smoke를 분리해서 보고해야 한다.
2. wrong-positive rate, no-result rate, concept-reject rate를 따로 본다.
3. operator tooling gate는 FE snapshot만으로 닫지 않는다. trusted API smoke가 필요하다.

## 절대 하지 말아야 할 구현

1. smoke를 mock response 기반으로만 닫는 것
2. one-off manual curl 결과를 공식 gate로 포장하는 것
3. closeout에서 alias hole/wrong-positive residue를 묻어버리는 것

## 실패 패턴

1. noisy eval은 green인데 ops API/web은 drift
2. hotset에 `opu one`, `dom perignon`, `까쇼`류가 빠져 있음
3. closeout이 owner-local green과 live smoke를 섞어 거짓 green이 됨

## 검증 명령

```bash
pnpm run test:verification:noisy
pnpm run test:integration:file -- test/integration/http/routes/primitive-search.route.test.ts
pnpm --dir web test
```

## DoD

1. entity lookup hotset gate가 존재한다.
2. operator read/write surface smoke가 존재한다.
3. closeout matrix가 residue를 숨기지 않는다.
