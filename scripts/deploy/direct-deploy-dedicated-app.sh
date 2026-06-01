#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  direct-deploy-dedicated-app.sh \
    [--region ap-northeast-2] \
    [--instance-id i-0e28f63452c548a9f] \
    [--repository-uri 527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine] \
    [--image-tag manual-ec2-amd64-20260601-010203] \
    [--container-name wine-search-engine] \
    [--host-port 4000] \
    [--app-port 3000] \
    [--host-bind-ip 0.0.0.0] \
    [--env-file /etc/wine-search-engine.env] \
    [--health-path /ready] \
    [--base-url https://asommguide.shop:9011] \
    [--query "opus one"] \
    [--lookup-query "opus one"] \
    [--platform linux/amd64] \
    [--artifact-bucket codex-harry-temp-artifacts-527687867704] \
    [--local-data-dir ~/.wine-search-engine/data] \
    [--compat-data-path /Users/songmin/.wine-search-engine/data]
EOF
}

REGION="ap-northeast-2"
INSTANCE_ID="i-0e28f63452c548a9f"
REPOSITORY_URI="527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine"
IMAGE_TAG="manual-ec2-amd64-$(date +%Y%m%d-%H%M%S)"
CONTAINER_NAME="wine-search-engine"
HOST_PORT="4000"
APP_PORT="3000"
HOST_BIND_IP="0.0.0.0"
ENV_FILE="/etc/wine-search-engine.env"
HEALTH_PATH="/ready"
BASE_URL="https://asommguide.shop:9011"
QUERY="opus one"
LOOKUP_QUERY="opus one"
PLATFORM="linux/amd64"
ARTIFACT_BUCKET="codex-harry-temp-artifacts-527687867704"
LOCAL_DATA_DIR="${HOME}/.wine-search-engine/data"
COMPAT_DATA_PATH="${HOME}/.wine-search-engine/data"
TAG_LATEST="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --repository-uri) REPOSITORY_URI="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --container-name) CONTAINER_NAME="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --host-bind-ip) HOST_BIND_IP="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --lookup-query) LOOKUP_QUERY="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --artifact-bucket) ARTIFACT_BUCKET="$2"; shift 2 ;;
    --local-data-dir) LOCAL_DATA_DIR="$2"; shift 2 ;;
    --compat-data-path) COMPAT_DATA_PATH="$2"; shift 2 ;;
    --no-tag-latest) TAG_LATEST="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for tool in aws docker curl python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool" >&2
    exit 1
  fi
done

if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="manual-ec2-amd64-$(date +%Y%m%d-%H%M%S)"
fi

REGISTRY_HOST="${REPOSITORY_URI%%/*}"
IMAGE_URI="${REPOSITORY_URI}:${IMAGE_TAG}"
BASE_URL="${BASE_URL%/}"

verify_endpoint() {
  local path="$1"
  local body="${2:-}"

  echo "[verify] ${path}"

  if [[ -z "$body" ]]; then
    curl -fsS "${BASE_URL}${path}" | python3 -m json.tool
    return
  fi

  curl -fsS -X POST "${BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -d "$body" | python3 -m json.tool
}

echo "[deploy] docker login: ${REGISTRY_HOST}"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY_HOST"

build_args=(
  buildx build
  --platform "$PLATFORM"
  -t "$IMAGE_URI"
  --push
)
if [[ "$TAG_LATEST" = "1" ]]; then
  build_args+=( -t "${REPOSITORY_URI}:latest" )
fi
build_args+=( . )

echo "[deploy] docker buildx build: ${IMAGE_URI}"
docker "${build_args[@]}"

echo "[deploy] sync runtime payload: ${INSTANCE_ID}"
bash scripts/deploy/sync-local-runtime-state-to-host.sh \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --local-data-dir "$LOCAL_DATA_DIR"

echo "[deploy] ensure dedicated env: ${INSTANCE_ID}"
bash scripts/deploy/ensure-dedicated-app-host-env.sh \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --env-file "$ENV_FILE"

echo "[deploy] ssm rollout: ${INSTANCE_ID}"
bash scripts/deploy/ssm-rollout-from-ecr.sh \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --repository-uri "$REPOSITORY_URI" \
  --image-tag "$IMAGE_TAG" \
  --container-name "$CONTAINER_NAME" \
  --host-port "$HOST_PORT" \
  --app-port "$APP_PORT" \
  --host-bind-ip "$HOST_BIND_IP" \
  --compat-data-path "$COMPAT_DATA_PATH" \
  --env-file "$ENV_FILE" \
  --health-path "$HEALTH_PATH"

echo "[deploy] local smoke warmup: ${INSTANCE_ID}"
bash scripts/deploy/ssm-smoke-app-endpoints.sh \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --port "$HOST_PORT" \
  --query "$QUERY" \
  --lookup-query "$LOOKUP_QUERY"

echo "[deploy] external verify: ${BASE_URL}"
verify_endpoint "/health"
verify_endpoint "/ready"
verify_endpoint "/v1/search/hybrid" "{\"query\":\"${QUERY}\"}"
verify_endpoint "/v1/search/semantic" "{\"query\":\"${QUERY}\"}"
verify_endpoint "/v1/search/lexical" "{\"query\":\"${QUERY}\"}"
verify_endpoint "/v1/lookup/wine" "{\"query\":\"${LOOKUP_QUERY}\"}"
verify_endpoint "/v1/agent" "{\"messages\":[{\"role\":\"user\",\"content\":\"${QUERY}\"}]}"
