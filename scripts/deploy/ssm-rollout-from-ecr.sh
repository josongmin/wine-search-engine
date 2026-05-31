#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ssm-rollout-from-ecr.sh \
    --region ap-northeast-2 \
    --instance-id i-abc123 \
    --repository-uri 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine \
    --image-tag sha-... \
    --container-name wine-search-engine \
    --host-port 4000 \
    --app-port 3000 \
    --host-bind-ip 127.0.0.1 \
    --compat-data-path /Users/songmin/.wine-search-engine/data \
    --env-file /etc/wine-search-engine.env \
    --health-path /ready
EOF
}

REGION=""
INSTANCE_ID=""
REPOSITORY_URI=""
IMAGE_TAG=""
CONTAINER_NAME="wine-search-engine"
HOST_PORT="4000"
APP_PORT="3000"
HOST_BIND_IP="127.0.0.1"
COMPAT_DATA_PATH=""
ENV_FILE="/etc/wine-search-engine.env"
HEALTH_PATH="/ready"
DATA_DIR="/opt/wine-search-engine/data"
HEALTH_TIMEOUT_SECONDS="120"
HEALTH_POLL_INTERVAL_SECONDS="3"

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
    --compat-data-path) COMPAT_DATA_PATH="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --health-timeout-seconds) HEALTH_TIMEOUT_SECONDS="$2"; shift 2 ;;
    --health-poll-interval-seconds) HEALTH_POLL_INTERVAL_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for key in REGION INSTANCE_ID REPOSITORY_URI IMAGE_TAG; do
  if [[ -z "${!key}" ]]; then
    echo "Missing required argument: ${key}" >&2
    usage
    exit 1
  fi
done

if [[ -z "$HOST_BIND_IP" ]]; then
  echo "Missing required argument: HOST_BIND_IP" >&2
  usage
  exit 1
fi

IMAGE_URI="${REPOSITORY_URI}:${IMAGE_TAG}"
REGISTRY_HOST="${REPOSITORY_URI%%/*}"
HEALTH_HOST="$HOST_BIND_IP"
case "$HOST_BIND_IP" in
  0.0.0.0|::|"::0")
    HEALTH_HOST="127.0.0.1"
    ;;
esac

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

IMAGE_URI="$IMAGE_URI" \
REGISTRY_HOST="$REGISTRY_HOST" \
REGION="$REGION" \
CONTAINER_NAME="$CONTAINER_NAME" \
HOST_PORT="$HOST_PORT" \
APP_PORT="$APP_PORT" \
HOST_BIND_IP="$HOST_BIND_IP" \
HEALTH_HOST="$HEALTH_HOST" \
ENV_FILE="$ENV_FILE" \
HEALTH_PATH="$HEALTH_PATH" \
DATA_DIR="$DATA_DIR" \
COMPAT_DATA_PATH="$COMPAT_DATA_PATH" \
HEALTH_TIMEOUT_SECONDS="$HEALTH_TIMEOUT_SECONDS" \
HEALTH_POLL_INTERVAL_SECONDS="$HEALTH_POLL_INTERVAL_SECONDS" \
python - "$tmpfile" <<'PY'
import json
import os
import sys

path = sys.argv[1]
commands = [
    "set -eu",
    f"IMAGE_URI='{os.environ['IMAGE_URI']}'",
    f"REGISTRY_HOST='{os.environ['REGISTRY_HOST']}'",
    f"AWS_REGION='{os.environ['REGION']}'",
    f"CONTAINER_NAME='{os.environ['CONTAINER_NAME']}'",
    f"HOST_PORT='{os.environ['HOST_PORT']}'",
    f"APP_PORT='{os.environ['APP_PORT']}'",
    f"HOST_BIND_IP='{os.environ['HOST_BIND_IP']}'",
    f"HEALTH_HOST='{os.environ['HEALTH_HOST']}'",
    f"ENV_FILE='{os.environ['ENV_FILE']}'",
    f"HEALTH_PATH='{os.environ['HEALTH_PATH']}'",
    f"DATA_DIR='{os.environ['DATA_DIR']}'",
    f"COMPAT_DATA_PATH='{os.environ['COMPAT_DATA_PATH']}'",
    f"HEALTH_TIMEOUT_SECONDS='{os.environ['HEALTH_TIMEOUT_SECONDS']}'",
    f"HEALTH_POLL_INTERVAL_SECONDS='{os.environ['HEALTH_POLL_INTERVAL_SECONDS']}'",
    'if [ ! -f "$ENV_FILE" ]; then echo "Missing env file: $ENV_FILE" >&2; exit 1; fi',
    'if [ ! -d "$DATA_DIR" ]; then echo "Missing data dir: $DATA_DIR" >&2; exit 1; fi',
    'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY_HOST"',
    'docker pull "$IMAGE_URI"',
    'docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true',
    'if [ -n "$COMPAT_DATA_PATH" ]; then',
    '  docker run -d --name "$CONTAINER_NAME" --restart unless-stopped --env-file "$ENV_FILE" -e PORT="$APP_PORT" -v "$DATA_DIR:/app/data:ro" -v "$DATA_DIR:$COMPAT_DATA_PATH:ro" -p "$HOST_BIND_IP":"$HOST_PORT":"$APP_PORT" "$IMAGE_URI"',
    'else',
    '  docker run -d --name "$CONTAINER_NAME" --restart unless-stopped --env-file "$ENV_FILE" -e PORT="$APP_PORT" -v "$DATA_DIR:/app/data:ro" -p "$HOST_BIND_IP":"$HOST_PORT":"$APP_PORT" "$IMAGE_URI"',
    'fi',
    'deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))',
    'healthy=0',
    'while [ "$(date +%s)" -lt "$deadline" ]; do',
    '  if curl -fsS "http://$HEALTH_HOST:$HOST_PORT/health" >/dev/null 2>&1 && curl -fsS "http://$HEALTH_HOST:$HOST_PORT$HEALTH_PATH" >/dev/null 2>&1; then healthy=1; break; fi',
    '  sleep "$HEALTH_POLL_INTERVAL_SECONDS"',
    'done',
    'if [ "$healthy" = "1" ]; then exit 0; fi',
    'echo "Health check failed: http://$HEALTH_HOST:$HOST_PORT$HEALTH_PATH" >&2',
    'docker logs --tail 200 "$CONTAINER_NAME" >&2 || true',
    'exit 1',
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Deploy ${CONTAINER_NAME}:${IMAGE_TAG}" \
    --parameters "file://${tmpfile}" \
    --query 'Command.CommandId' \
    --output text
)"

echo "SSM command started: ${command_id}"

status=""
for _ in $(seq 1 120); do
  status="$(
    aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query 'Status' \
      --output text 2>/dev/null || true
  )"
  case "$status" in
    Success) break ;;
    Cancelled|TimedOut|Failed|Cancelling)
      aws ssm get-command-invocation \
        --region "$REGION" \
        --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 1
      ;;
  esac
  sleep 5
done

aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
