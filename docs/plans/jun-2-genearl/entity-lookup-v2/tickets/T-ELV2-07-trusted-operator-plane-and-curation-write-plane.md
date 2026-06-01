# T-ELV2-07 Trusted Operator Plane And Curation Write Plane

## 목표

lookup V2의 read/debug plane과 curation write plane을 운영자가 쓸 수 있는 수준으로 만든다.

## 정확한 산출물

1. trusted debug API
2. alias audit API
3. coverage/health API
4. proposal/ambiguity/suppression write plane
5. web ops console

## 반드시 건드릴 파일

1. `src/interface/http/**`
2. `web/**`
3. `scripts/etl/**`
4. `src/infrastructure/db/migrations/**`

## 구현 범위

1. read-only ops surface
2. operator auth
3. curation review/write plane
4. web console

## 금지사항

1. public product API에 ops payload 섞기
2. runtime plane direct mutation

## DoD

1. operator가 query 하나로 decision spine을 브라우저에서 본다.
2. alias/ambiguity/suppression을 staging 기반으로 운영한다.
