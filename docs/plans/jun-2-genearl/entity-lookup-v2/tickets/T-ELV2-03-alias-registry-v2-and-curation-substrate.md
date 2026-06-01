# T-ELV2-03 Alias Registry V2 And Curation Substrate

## 목표

lookup V2 전용 alias registry와 curation substrate를 만들고, top entity coverage를 운영 가능한 artifact로 관리한다.

## 정확한 산출물

1. dedicated alias registry schema/version
2. curated alias source
3. transliteration / abbreviation / family alias provenance
4. hot entity coverage report

## 반드시 건드릴 파일

1. `scripts/etl/**`
2. `src/domain/alias/**`
3. `src/infrastructure/db/migrations/**`
4. `test/**`

## 구현 범위

1. alias artifact schema v2
2. curation/proposal plane
3. coverage audit
4. publish wiring

## 금지사항

1. runtime plane direct edits
2. provenance 없는 curated alias 추가

## DoD

1. `dom perignon`류 hot entity hole이 audit report와 curation flow에서 다뤄진다.
2. alias registry가 lookup V2 authority로 분리된다.
