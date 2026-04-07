# Apr 7 — Hardening Wave 5 (dockerized full-runtime replay lane)

**목적:** runtime-required replay를 self-contained / in-memory / full-runtime 3개 lane으로 분리하고, Dockerized CI에서 실제 서비스 배선으로 replay regression을 잡는다.  
**범위:** fixture schema v2.1, full-runtime E2E suite, workflow 3-lane 고정, artifact/log export, 운영 문구 정렬.

## 현재 상태

| 항목 | 상태 | 비고 |
|------|------|------|
| `metadata.runtime_mode` fixture contract | 완료 | `inmemory` / `full_runtime` 필수 구분 |
| full-runtime fixture는 `use_live_snapshot=true` 강제 | 완료 | `run-search-fixture.ts` schema invariant |
| full-runtime replay suite | 완료 | `test/e2e/vespa/search-replay-full-runtime-fixtures.test.ts` |
| Dockerized CI lane | 완료 | `.github/workflows/replay-fixtures.yml` |
| package scripts 3-lane 정렬 | 완료 | `package.json` |
| workflow summary + docker log artifact | 완료 | full-runtime lane에서 summary/artifact export |
| dependency health probe | 완료 | fake ML `/embeddings` `/match` `/rerank` probe |
| fixture execution report artifact | 완료 | full-runtime suite가 fixture별 surfaced contract를 JSON artifact로 export |

## Lane SSOT

1. `self_contained`
   - 목적: schema / payload / replay contract 회귀
   - 실행: `npm run test:e2e:replay:fixtures:self-contained`

2. `runtime_required` + `metadata.runtime_mode='inmemory'`
   - 목적: capability-aware deterministic simulation
   - 실행: `npm run test:e2e:replay:fixtures:runtime-required`

3. `runtime_required` + `metadata.runtime_mode='full_runtime'`
   - 목적: Dockerized live service regression
   - 실행: `npm run test:e2e:replay:fixtures:full-runtime`

## Full-runtime fixture truth

- `heuristic-drinking-window-full-runtime`
  - exact contract: `heuristic`
  - reasons: `['heuristic_drinking_window']`
  - note: replay now preserves a preflight honesty floor, and the Vespa test stack wires the drinking-window use case into `/v1/search`, so live-snapshot full-runtime replay can surface predictor-derived heuristic DW honestly.

- `learned-matcher-timeout`
  - exact contract: `degraded`
  - reasons: `['learned_matcher_timeout']`

- `reranker-timeout`
  - exact contract: `degraded`
  - reasons: `['reranker_timeout']`
  - note: seeded full-runtime corpus now carries a learned drinking-window model version by default, so non-drinking-window fixtures no longer inherit incidental `heuristic_drinking_window`.

## In-memory shadow fixture

- `runtime_required + inmemory` lane
  - capability-aware deterministic simulation rail
  - `heuristic-drinking-window` remains the canonical shadow fixture for `drinking_window_runtime`.
  - exact contract: `heuristic`
  - reasons: `['heuristic_drinking_window']`

## 운영 규칙

- bootstrap smoke는 full-runtime lane을 포함하지 않는다.
- full-runtime lane은 skip이 아니라 failure-first다.
- workflow는 full-runtime lane에서 Docker logs artifact를 항상 업로드한다.
- fixture expectation은 구현 truth보다 낙관적으로 낮추지 않는다.
