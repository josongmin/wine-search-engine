# T-ELV2-08 Hotset Eval Shadow Compare Cutover And Legacy Purge

> Current status (2026-06-03): full authority gate PASS, compatibility-backed
> cutover shipped. Remaining work is live canary + legacy purge closeout.

## 목표

lookup V2가 V1보다 실제로 낫다는 증거를 확보하고, cutover 후 legacy V1 lookup path를 정리한다.

## 정확한 산출물

1. hotset eval corpus
2. shadow compare report
3. cutover checklist
4. legacy purge plan
5. executable bench/doc status SSOT

## 반드시 건드릴 파일

1. `scripts/eval/**`
2. `test/**`
3. `docs/**`
4. `src/interface/http/**`

## 구현 범위

1. V1 vs V2 replay/shadow harness
2. precision/recall/abstain/redirect metrics
3. live smoke
4. deprecation/cutover docs
5. benchmark/doc lane alignment

## 금지사항

1. shadow compare 없이 cutover
2. hotset 없이 anecdotal query 몇 개로 완료 선언
3. missing runner/command를 current proof lane처럼 문서화

## DoD

1. full authority gate가 PASS로 고정된다.
2. cutover와 legacy purge 조건이 문서/rail로 고정된다.
3. current bench/doc lane이 executable command만 가리킨다.
