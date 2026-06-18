#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ssm-smoke-app-endpoints.sh \
    --region ap-northeast-2 \
    --instance-id i-0e28f63452c548a9f \
    [--host 127.0.0.1] \
    [--port 4000] \
    [--query "opus one"] \
    [--lookup-query "opus one"]
EOF
}

REGION=""
INSTANCE_ID=""
HOST="127.0.0.1"
PORT="4000"
QUERY="opus one"
LOOKUP_QUERY="opus one"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --lookup-query) LOOKUP_QUERY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$REGION" || -z "$INSTANCE_ID" ]]; then
  echo "Missing required arguments: --region, --instance-id" >&2
  usage
  exit 1
fi

parameters_json="$(
  HOST="$HOST" PORT="$PORT" QUERY="$QUERY" LOOKUP_QUERY="$LOOKUP_QUERY" python3 <<'PY'
import json
import os

host = os.environ["HOST"]
port = os.environ["PORT"]
query = os.environ["QUERY"]
lookup_query = os.environ["LOOKUP_QUERY"]

commands = [
    "set -eu",
    f"base_url='http://{host}:{port}'",
    "post_json() { path=\"$1\"; body=\"$2\"; echo \"[smoke] $path\"; curl -fsS --max-time 30 -H \"Content-Type: application/json\" -d \"$body\" \"$base_url$path\" >/dev/null; }",
    "get_json() { path=\"$1\"; echo \"[smoke] $path\"; curl -fsS --max-time 30 \"$base_url$path\" >/dev/null; }",
    "get_json /health",
    "get_json /ready",
    f"post_json /v1/search/hybrid '{json.dumps({'query': query})}'",
    f"post_json /v1/search/semantic '{json.dumps({'query': query})}'",
    f"post_json /v1/search/lexical '{json.dumps({'query': query})}'",
    f"post_json /v2/entity-lookup '{json.dumps({'query': lookup_query})}'",
    f"post_json /v1/agent '{json.dumps({'messages': [{'role': 'user', 'content': query}]})}'",
]

print(json.dumps({"commands": commands}))
PY
)"

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "Smoke app endpoints" \
    --parameters "$parameters_json" \
    --query 'Command.CommandId' \
    --output text
)"

echo "SSM smoke command started: ${command_id}"

while true; do
  status="$(
    aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query 'Status' \
      --output text
  )"

  case "$status" in
    Success)
      aws ssm get-command-invocation \
        --region "$REGION" \
        --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 0
      ;;
    Cancelled|TimedOut|Failed|Cancelling)
      aws ssm get-command-invocation \
        --region "$REGION" \
        --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 1
      ;;
    Pending|InProgress|Delayed)
      sleep 2
      ;;
    *)
      echo "Unexpected SSM status: $status" >&2
      exit 1
      ;;
  esac
done
