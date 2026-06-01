# Dedicated App Host Deploy Runbook

이 문서는 `wine-search-engine`를 shared host에서 분리된 전용 app host로 운영하는 절차를 정리한다. 공개 경로는 당분간 기존 ingress host의 nginx를 유지한다.

## 목표 토폴로지

- public ingress
  - host: 기존 shared host
  - 역할: TLS 종료, `:9011` 공개, nginx reverse proxy
- dedicated app host
  - 역할: `wine-search-engine` docker container만 실행
  - bind: `0.0.0.0:4000 -> container:3000`
- Vespa
  - 역할: 기존 검색 백엔드 유지

외부 공개 경로는 계속 아래를 유지한다.

```text
https://asommguide.shop:9011
```

## 현재 운영 기준값

2026-06-01 live 확인 기준:

- AWS account: `527687867704`
- region: `ap-northeast-2`
- ingress host instance: `i-0e3df08f16fe1c1b5`
- ingress host private IP: `172.31.16.204`
- ingress host public IP: `15.165.105.163`
- ingress host SG: `sg-0b982b1f3bdb91c91` (`admin web`)
- dedicated app host instance: `i-0e28f63452c548a9f`
- dedicated app host private IP: `172.31.24.50`
- dedicated app host public IP: `15.164.49.125`
- dedicated app host SG: `sg-0035f289980c07b8b` (`wine-search-engine-app-prod`)
- Vespa host instance: `i-06cbec79408547420`
- Vespa host private IP: `172.31.10.93`
- Vespa SG: `sg-0e9438b58ade773e6`
- subnet for dedicated host: `subnet-e3466ca9`
- VPC: `vpc-4340a92a`
- instance profile: `EC2SSMManagedProfileTemp`
- artifact bucket for runtime-state relay: `codex-harry-temp-artifacts-527687867704`
- ECR repo: `527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine`
- container name: `wine-search-engine`
- env file: `/etc/wine-search-engine.env`
- data dir: `/opt/wine-search-engine/data`
- ingress config path: `/etc/nginx/sites-available/wine-search-engine-public.conf`

## 1. 전용 app host 프로비저닝

최소 기준:

- instance type: `t3.medium`
- AMI: Ubuntu 24.04 amd64
- root volume: `gp3 30GB`
- inbound: `4000/tcp` only from ingress host SG
- outbound: default egress
- management: SSM only

실행:

```bash
bash scripts/deploy/provision-dedicated-app-host.sh \
  --region ap-northeast-2 \
  --subnet-id subnet-e3466ca9 \
  --ingress-source-sg-id sg-0b982b1f3bdb91c91 \
  --vespa-sg-id sg-0e9438b58ade773e6 \
  --instance-profile-name EC2SSMManagedProfileTemp \
  --instance-name wine-search-engine-app-prod \
  --security-group-name wine-search-engine-app-prod
```

이 스크립트는:

- dedicated app SG 생성 또는 재사용
- app SG에 `4000/tcp <- ingress host SG` 허용
- Vespa SG에 `8080`, `19071`, `19092 <- dedicated app SG` 허용
- EC2 생성
- SSM online 대기
- `bootstrap-app-host.sh` 실행

## 2. 런타임 상태 복제

현재 앱은 아래 3개 파일 없이는 동일 상태로 올라오지 않는다.

- `/etc/wine-search-engine.env`
- `/opt/wine-search-engine/data/runtime-search-snapshot.json`
- `/opt/wine-search-engine/data/nl-mappings.json`

복제:

```bash
bash scripts/deploy/clone-runtime-state-between-hosts.sh \
  --region ap-northeast-2 \
  --source-instance-id i-0e3df08f16fe1c1b5 \
  --target-instance-id i-0e28f63452c548a9f \
  --s3-bucket codex-harry-temp-artifacts-527687867704
```

이 경로는 `SSM -> S3 -> SSM`으로만 이동한다. SSH 의존성은 없다.

## 2.5. dedicated host 운영 env 고정

전용 public search host는 아래 값을 명시적으로 유지해야 한다.

- `SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME=false`
- `INJECTION_JUDGE_FAIL_OPEN=true`
- `OPENAI_INJECTION_HTTP_TIMEOUT_MS=5000`
- `INJECTION_JUDGE_TIMEOUT_MS=5000`

이유:

- 현재 public search request budget은 `30s`다.
- Layer 2 judge를 `45s + fail_closed`로 두면 cold request에서 ordinary query도 timeout/abort로 죽는다.
- dedicated host direct deploy는 이 값을 자동으로 upsert한다.

수동 적용이 필요하면:

```bash
bash scripts/deploy/ensure-dedicated-app-host-env.sh \
  --region ap-northeast-2 \
  --instance-id i-0e28f63452c548a9f \
  --env-file /etc/wine-search-engine.env
```

## 3. 새 host에 동일 이미지 배포

현재 운영 이미지와 동일 태그로 먼저 올려서 환경 분리만 검증하는 것이 가장 안전하다.

예시:

```bash
bash scripts/deploy/ssm-rollout-from-ecr.sh \
  --region ap-northeast-2 \
  --instance-id i-0e28f63452c548a9f \
  --repository-uri 527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine \
  --image-tag manual-ec2-amd64-v4 \
  --container-name wine-search-engine \
  --host-port 4000 \
  --app-port 3000 \
  --host-bind-ip 0.0.0.0 \
  --env-file /etc/wine-search-engine.env \
  --health-path /ready
```

중요:

- dedicated host에서는 `--host-bind-ip 0.0.0.0`를 사용한다.
- 기존 shared host는 계속 기본값 `127.0.0.1`을 유지한다.
- dedicated host SG가 public inbound를 열지 않으므로 외부 직접 노출은 되지 않는다.

## 4. cutover 전 내부 확인

shared ingress host에서 dedicated host private IP로 readiness를 본다.

```bash
aws ssm send-command \
  --region ap-northeast-2 \
  --instance-ids i-0e3df08f16fe1c1b5 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["curl -fsS http://172.31.24.50:4000/health","curl -fsS http://172.31.24.50:4000/ready"]'
```

둘 다 성공해야 ingress 전환을 진행한다.

## 5. ingress upstream 전환

public TLS는 기존 shared host nginx가 유지한다. upstream만 dedicated host private IP로 바꾼다.

```bash
bash scripts/deploy/switch-shared-ingress-upstream.sh \
  --region ap-northeast-2 \
  --instance-id i-0e3df08f16fe1c1b5 \
  --upstream-host 172.31.24.50 \
  --public-port 9011 \
  --upstream-port 4000
```

성공 후 외부 경로는 그대로 유지되며, 실제 upstream만 바뀐다.

## 6. 외부 smoke

최소 확인:

```bash
curl -fsS https://asommguide.shop:9011/health
curl -fsS https://asommguide.shop:9011/ready
curl -fsS https://asommguide.shop:9011/v1/search/hybrid \
  -H 'content-type: application/json' \
  --data '{"query":"opus one 비슷한 와인"}'
```

## Access Info

외부:

- base URL: `https://asommguide.shop:9011`
- readiness: `https://asommguide.shop:9011/ready`
- health: `https://asommguide.shop:9011/health`
- hybrid search: `https://asommguide.shop:9011/v1/search/hybrid`
- semantic search: `https://asommguide.shop:9011/v1/search/semantic`
- lexical search: `https://asommguide.shop:9011/v1/search/lexical`
- lookup: `https://asommguide.shop:9011/v1/lookup/wine`
- agent: `https://asommguide.shop:9011/v1/agent`

내부:

- ingress upstream target: `http://172.31.24.50:4000`
- dedicated host EC2: `i-0e28f63452c548a9f`
- dedicated host public IP: `15.164.49.125`
- dedicated host SG: `sg-0035f289980c07b8b`
- container app port: `3000`
- required runtime files:
  - `/etc/wine-search-engine.env`
  - `/opt/wine-search-engine/data/runtime-search-snapshot.json`
  - `/opt/wine-search-engine/data/nl-mappings.json`

## Rollback

즉시 rollback은 nginx upstream만 되돌리면 된다.

```bash
bash scripts/deploy/switch-shared-ingress-upstream.sh \
  --region ap-northeast-2 \
  --instance-id i-0e3df08f16fe1c1b5 \
  --upstream-host 127.0.0.1 \
  --public-port 9011 \
  --upstream-port 4000
```

필요하면 그 다음 dedicated host 컨테이너를 별도로 내리거나 이전 태그로 재배포한다.

현재 cutover 상태에서는 shared host의 기존 local container를 그대로 남겨 두고 ingress upstream만 바꿨다. 이 상태가 rollback 속도는 가장 빠르다.

## Failure Modes

- runtime state 미복제
  - 증상: `/ready` fail, snapshot/runtime errors
- dedicated host SG 오설정
  - 증상: ingress host에서 `curl http://<dedicated-private-ip>:4000/...` timeout
- Vespa SG 규칙 누락
  - 증상: app boot 후 readiness에서 Vespa dependency down
- ingress 전환 후 nginx만 살아 있고 app upstream dead
  - 증상: 외부 `502 Bad Gateway`

## 다음 단계

이 문서의 전환은 `app workload`만 분리한다. 완전 분리를 원하면 추가로 아래를 수행해야 한다.

- public DNS zone custody 정리
- dedicated host 또는 ALB로 TLS 종단 이동
- shared ingress host 의존성 제거
