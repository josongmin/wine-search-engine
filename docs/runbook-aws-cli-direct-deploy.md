# AWS CLI Direct Deploy Runbook

이 경로는 GitHub-hosted Actions 없이 `AWS CLI + S3 + SSM + systemd`만으로 배포한다.

## 개요

1. 로컬 작업 트리에서 소스 번들을 만든다.
2. 번들을 S3에 업로드한다.
3. `AWS-RunShellScript`로 EC2에 배포 명령을 보낸다.
4. EC2가 번들을 받아 `pnpm install -> pnpm run build`를 수행한다.
5. `current` 심링크를 새 release로 전환하고 systemd 서비스를 재시작한다.
6. `GET /health`, `GET /ready`가 통과하면 성공이다.

현재 스크립트: [scripts/deploy/ssm-rollout-node-from-s3.sh](/Users/songmin/Documents/code-wine/wine-search-engine/scripts/deploy/ssm-rollout-node-from-s3.sh:1)

## 언제 이 경로를 쓰나

- private repo의 GitHub-hosted Actions 분/결제를 쓰고 싶지 않을 때
- Docker/ECR build lane 없이 EC2에서 직접 build 하고 싶을 때
- `aws ssm send-command` 기반 수동 배포가 더 단순할 때

## 전제 조건

로컬:

- `aws`
- `git`
- `python3`

EC2 host:

- SSM agent online
- `aws` CLI 설치
- `node` 22.x
- `corepack`
- 배포 대상 env 파일 존재
  - 기본값: `/etc/wine-search-engine.env`

필수 IAM:

- 로컬 실행 주체: `s3:PutObject`, `ssm:SendCommand`, `ssm:GetCommandInvocation`
- EC2 instance role: 업로드된 S3 artifact read 권한

## 1회 준비

host에 env 파일을 만든다.

예시:

```env
NODE_ENV=production
DATABASE_URL=postgresql://...
PG_SSL=true
PG_SSL_REJECT_UNAUTHORIZED=false
VESPA_URL=http://...
REDIS_URL=redis://...
OPENAI_API_KEY=...
COHERE_API_KEY=...
HTTP_DEBUG_SECRET=...
```

중요:

- 이 direct deploy 경로는 systemd unit에서 `PORT=<host-port>`를 강제로 주입한다.
- 따라서 env 파일의 `PORT` 값은 배포 시 실제 listen port 결정에 쓰이지 않는다.
- 애플리케이션 코드가 `0.0.0.0`으로 listen 하므로, `host-port`가 security group / host firewall 에서 열려 있으면 direct 노출된다.
- 기존 Docker 경로처럼 loopback NAT 격리가 없으니, 외부 공개는 nginx/ALB 경로와 SG 규칙을 같이 봐야 한다.

## 배포 명령

기본 예시:

```bash
bash scripts/deploy/ssm-rollout-node-from-s3.sh \
  --region ap-northeast-2 \
  --instance-id i-xxxxxxxx \
  --s3-bucket my-deploy-artifacts \
  --s3-prefix wine-search-engine/direct \
  --host-port 4000 \
  --env-file /etc/wine-search-engine.env \
  --health-path /ready
```

마이그레이션까지 같이 실행:

```bash
bash scripts/deploy/ssm-rollout-node-from-s3.sh \
  --region ap-northeast-2 \
  --instance-id i-xxxxxxxx \
  --s3-bucket my-deploy-artifacts \
  --run-migrate
```

## host에 남는 구조

기본 루트는 `/opt/wine-search-engine`:

- `releases/<release-id>`: 배포별 소스 + node_modules
- `current`: 활성 release 심링크
- `build`: 외부 build artifact 루트 (`dist` 심링크 대상)
- `data`: 런타임 data 루트

systemd unit:

- `/etc/systemd/system/wine-search-engine.service`

서비스 실행 커맨드:

- `node /opt/wine-search-engine/current/dist/main.js`

## 실패 시 동작

- 새 release의 build 또는 health check가 실패하면 배포는 실패 처리된다.
- health check 실패 시 직전 `current` 타깃이 있으면 그쪽으로 심링크를 되돌리고 서비스 restart를 시도한다.
- journal 최근 200줄을 stderr로 출력한다.

## 주의점

- 이 경로는 EC2 host에서 직접 `pnpm install`을 수행하므로 host에 build toolchain drift가 남는다.
- rollback은 release 심링크 복구 수준이지 immutable image rollback은 아니다.
- 현재 스크립트는 기본으로 DB migration을 실행하지 않는다. 필요하면 `--run-migrate`를 붙여야 한다.
- `Node 22`가 아니면 스크립트가 hard fail 한다.

## 운영 판단

이 경로는 GitHub Actions 과금 회피에는 적합하다. 다만 운영 재현성은 `ECR image rollout`보다 약하다. 장기적으로는 아래 둘 중 하나로 정리하는 편이 낫다.

- self-hosted runner로 기존 image deploy 유지
- direct deploy를 계속 쓸 경우 host bootstrap, IAM, rollback 절차를 별도 표준화
