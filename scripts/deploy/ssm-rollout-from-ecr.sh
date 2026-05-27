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
ENV_FILE="/etc/wine-search-engine.env"
HEALTH_PATH="/ready"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --repository-uri) REPOSITORY_URI="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --container-name) CONTAINER_NAME="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
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

IMAGE_URI="${REPOSITORY_URI}:${IMAGE_TAG}"
REGISTRY_HOST="${REPOSITORY_URI%%/*}"

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

cat > "$tmpfile" <<EOF
{
  "commands": [
    "set -eu",
    "IMAGE_URI='${IMAGE_URI}'",
    "REGISTRY_HOST='${REGISTRY_HOST}'",
    "AWS_REGION='${REGION}'",
    "CONTAINER_NAME='${CONTAINER_NAME}'",
    "HOST_PORT='${HOST_PORT}'",
    "APP_PORT='${APP_PORT}'",
    "ENV_FILE='${ENV_FILE}'",
    "HEALTH_PATH='${HEALTH_PATH}'",
    "if [ ! -f \\\"\\\$ENV_FILE\\\" ]; then echo Missing env file: \\\"\\\$ENV_FILE\\\" >&2; exit 1; fi",
    "aws ecr get-login-password --region \\\"\\\$AWS_REGION\\\" | docker login --username AWS --password-stdin \\\"\\\$REGISTRY_HOST\\\"",
    "docker pull \\\"\\\$IMAGE_URI\\\"",
    "docker rm -f \\\"\\\$CONTAINER_NAME\\\" >/dev/null 2>&1 || true",
    "docker run -d --name \\\"\\\$CONTAINER_NAME\\\" --restart unless-stopped --env-file \\\"\\\$ENV_FILE\\\" -e PORT=\\\"\\\$APP_PORT\\\" -p 127.0.0.1:\\\"\\\$HOST_PORT\\\":\\\"\\\$APP_PORT\\\" \\\"\\\$IMAGE_URI\\\"",
    "for i in 1 2 3 4 5 6 7 8 9 10; do if curl -fsS \\\"http://127.0.0.1:\\\$HOST_PORT\\\$HEALTH_PATH\\\" >/dev/null; then exit 0; fi; sleep 3; done",
    "echo Health check failed: http://127.0.0.1:\\\$HOST_PORT\\\$HEALTH_PATH >&2",
    "docker logs --tail 200 \\\"\\\$CONTAINER_NAME\\\" >&2 || true",
    "exit 1"
  ]
}
EOF

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Deploy ${IMAGE_URI}" \
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
