# GitHub Actions + AWS EC2 Deploy Runbook

이 repo의 저트래픽 배포 기본형은 `GitHub Actions -> AWS OIDC -> ECR -> SSM -> EC2 Docker rollout`이다.

## 구조

1. GitHub Actions가 `main` 기준으로 실행된다.
2. Actions는 AWS OIDC role을 assume 한다.
3. Docker 이미지를 ECR에 push 한다.
4. Actions는 SSM `AWS-RunShellScript`로 EC2에 rollout command를 보낸다.
5. EC2는 새 이미지를 pull 한 뒤 기존 컨테이너를 교체하고 `http://127.0.0.1:<host-port>/ready`를 확인한다.
6. 외부 공개는 nginx가 별도 TLS public port에서 `127.0.0.1:<host-port>`로 reverse proxy 한다.

## 왜 이 구조인가

- 저트래픽 초기에는 ECS/EKS보다 훨씬 단순하다.
- SSH inbound 없이 SSM으로 배포할 수 있다.
- host에 GitHub deploy key를 둘 필요가 없다.
- repo는 이미 Dockerfile이 있고, host는 Docker만 있으면 된다.

## 필요한 GitHub repo variables

- `AWS_REGION`
- `AWS_DEPLOY_ROLE_ARN`
- `DEPLOY_ECR_REPOSITORY`
- `DEPLOY_EC2_INSTANCE_ID`
- `DEPLOY_CONTAINER_NAME`
- `DEPLOY_HOST_PORT`
- `DEPLOY_APP_PORT`
- `DEPLOY_ENV_FILE`
- `DEPLOY_HEALTH_PATH`

## one-time bootstrap

### 1. EC2 host 준비

host에서 root로:

```bash
bash scripts/deploy/bootstrap-app-host.sh
```

그 다음 `/etc/wine-search-engine.env`를 실제 값으로 채운다.

최소 예시:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
VESPA_URL=http://...
HTTP_DEBUG_SECRET=...
OPENAI_API_KEY=...
COHERE_API_KEY=...
```

### 2. GitHub <-> AWS 배포 권한 bootstrap

워크스테이션에서:

```bash
bash scripts/deploy/bootstrap-github-aws-ec2-pipeline.sh \
  --instance-id i-xxxxxxxx \
  --region ap-northeast-2 \
  --ecr-repo wine-search-engine \
  --container-name wine-search-engine \
  --host-port 4000 \
  --app-port 3000 \
  --env-file /etc/wine-search-engine.env \
  --health-path /ready
```

이 스크립트는:

- GitHub OIDC deploy role 생성/업데이트
- ECR repo 생성
- target EC2 instance role에 `AmazonEC2ContainerRegistryReadOnly` 부착
- GitHub repo variables 설정

## 배포 방식

### 자동

- `main` 브랜치에서 `CI` workflow가 성공하면 `Deploy Production`이 실행된다.

### 수동

- GitHub Actions에서 `Deploy Production` workflow를 수동 실행한다.
- `git_ref`와 `image_tag`는 선택이다.

## host에서 실제로 실행되는 배포

원격 rollout command는 아래 순서다.

1. `aws ecr get-login-password`
2. `docker pull <image>`
3. 기존 컨테이너 제거
4. 새 컨테이너 실행
5. `curl http://127.0.0.1:<host-port>/ready`

기본은 host loopback에만 바인딩된다.

```text
127.0.0.1:<host-port> -> container:<app-port>
```

외부 공개가 필요하면 nginx 또는 ALB에서 해당 포트로 reverse proxy를 둔다.

## 외부 공개

공유 호스트를 깨지 않기 위해 기본 권장은 `443` 기존 라우트 수정이 아니라 별도 public TLS port를 여는 방식이다.

예시:

```bash
sudo PUBLIC_PORT=9011 \
  UPSTREAM_PORT=4000 \
  SERVER_NAMES="asommguide.shop shop.asommguide.com" \
  CERT_BASE=/etc/letsencrypt/live/asommguide.shop \
  bash scripts/deploy/provision-nginx-public-port.sh
```

그 다음 EC2 security group에서 `9011/tcp`를 열면 외부 URL은:

```text
https://asommguide.shop:9011/ready
https://asommguide.shop:9011/v1/search
```

이 방식의 장점:

- 기존 `443` consumer frontend를 안 건드린다.
- 새 앱은 loopback `127.0.0.1:4000`에만 바인딩된다.
- nginx와 SG에서 공개 범위가 명확하다.

## 운영 원칙

- `/ready`는 search-core 기준이다. LTR은 optional capability다.
- 배포 workflow는 image push와 rollout만 담당한다.
- Vespa schema deploy와 search snapshot publish는 별도 운영 lane이다.

## 권장 다음 단계

- nginx public port 또는 ALB target group 추가
- GitHub environment protection 추가
- deploy 이후 `/ready` 외에 smoke query 한두 개까지 붙이기
- app host를 전용 EC2로 분리하기
