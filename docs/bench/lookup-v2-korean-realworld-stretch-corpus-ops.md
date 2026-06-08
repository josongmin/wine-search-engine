# Lookup V2 Korean Realworld Stretch Corpus Ops

## Goal

- stretch 코퍼스를 ad hoc append가 아니라 repeatable pipeline으로 관리한다.
- 외부 LLM 출력은 authority가 아니다.
- candidate는 fixture merge 전에 schema / duplicate / qid contract를 통과해야 한다.

## Current Flow

1. current corpus stats 확인
   - `pnpm run eval:lookup-v2:stretch:report`
2. external-LLM prompt 생성
   - `pnpm run eval:lookup-v2:stretch:build-expansion-prompt`
   - output:
     - `/Users/songmin/.wine-search-engine/data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-expansion-prompt.txt`
3. external LLM이 candidate JSONL 생성
   - qid 없이 생성 가능
   - required schema:
     - `query`
     - `expected_status`
     - `class`
     - `note`
     - `expected_entity_hint` only for `resolved`
4. candidate merge
   - `pnpm run eval:lookup-v2:stretch:merge-candidate -- --candidate /abs/path/candidate.jsonl --output /tmp/lookup-v2-korean-realworld-stretch.merged.jsonl`
   - optional:
     - `--qidPrefix kry`
     - `--write`
5. merged corpus를 parity / coverage rail로 재검증
   - `pnpm run eval:lookup-v2:parity:korean-realworld-stretch`
   - `pnpm run eval:lookup-v2:coverage:korean-realworld-stretch`

## Write Path Truth

- lookup-v2 draft/write-plane 기본 출력은 repo 아래가 아니라
  `/Users/songmin/.wine-search-engine/data/lookup-v2/drafts` 다.
- live CLI는 repo-relative `data/lookup-v2/drafts/...` 기본값을 직접 쓰지 않고
  path-authority helper를 통해 home data dir로 resolve된다.

## Contracts

- qid가 없는 candidate row는 merge 시 deterministic append qid를 받는다.
- default qid prefix는 `kry`.
- duplicate `query`는 fail-closed다.
- non-resolved row는 `expected_entity_hint`를 가질 수 없다.
- resolved row는 `expected_entity_hint`가 필수다.
- corpus append는 entity lookup과 discovery query를 같은 파일에 둘 수 있지만,
  downstream rail에서는 `entity-only`, `entity-no-policy`, `discovery-only`
  partition으로 다시 분리된다.

## Non-goals

- candidate를 runtime hint로 자동 authority 승격하지 않는다.
- merge lane은 registry write를 하지 않는다.
- exact-safe / policy / family-target decision은 별도 write-plane owner다.
