# System overview (리뷰 전용)

이 디렉터리는 **시스템·아키텍처 리뷰할 때만** 쓰는 읽기 순서와 요약을 두는 곳이다. **온보딩 SSOT나 장기 문서가 아니다.**  
`docs/sessions/`, `docs/bugbash-*` 등 다른 메모는 정리되거나 지워질 수 있고, **리뷰 시에는 아래 목록만 보면 된다.**

## 리뷰용 읽기 순서 (짧게)

1. **루트 `CLAUDE.md`** — 스택, 디렉터리, `npm run` 품질 게이트  
2. **`retriever-pipeline.md`** (이 폴더) — 하이브리드 리트리버 경로(후보 생성·풀·코드 라인 인용)  
3. **`ingestion-pipeline.md`** (이 폴더) — Bronze→Silver→Enriched→Vespa·평가 시딩·`scripts/etl` 전부  
4. **`docs/http-contract-surface.md`** — 공개 HTTP 계약의 SSOT가 어디인지  
5. **`docs/RFC-INDEX.md`** — 목차만 보고 필요한 RFC만 골라 읽기  
6. **도메인·계약 축** (리뷰 깊이에 따라 선택): `RFC-000` → `RFC-005`~`008` → `RFC-014`~`016` (`docs/RFC-*.md`)

그 외 계획서·버그배시·세션 노트는 **리뷰 필수 경로에 넣지 않는다.**

## 이 폴더에 있는 파일

| 파일 | 용도 |
|------|------|
| `README.md` | 리뷰 전용 스코프·읽기 순서 (본 파일) |
| `retriever-pipeline.md` | 리트리버 파이프라인 요약 + 관련 소스 코드 라인 인용 |
| `ingestion-pipeline.md` | 인입·ETL·인덱싱·평가 시딩 스크립트 전체 목록 + 코드 인용 |
