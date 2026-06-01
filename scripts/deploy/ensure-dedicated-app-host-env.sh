#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ensure-dedicated-app-host-env.sh \
    --region ap-northeast-2 \
    --instance-id i-0e28f63452c548a9f \
    [--env-file /etc/wine-search-engine.env]
EOF
}

REGION=""
INSTANCE_ID=""
ENV_FILE="/etc/wine-search-engine.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
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
  ENV_FILE="$ENV_FILE" python3 <<'PY'
import json
import os

env_file = os.environ["ENV_FILE"]
desired = {
    "SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME": "false",
    "INJECTION_JUDGE_FAIL_OPEN": "true",
    "OPENAI_INJECTION_HTTP_TIMEOUT_MS": "5000",
    "INJECTION_JUDGE_TIMEOUT_MS": "5000",
}

desired_json = json.dumps(desired, sort_keys=True)
commands = [
    "set -eu",
    "python3 <<'PY'\n"
    "import json\n"
    "from pathlib import Path\n"
    "\n"
    f"path = Path({env_file!r})\n"
    f"desired = json.loads({desired_json!r})\n"
    "if path.exists():\n"
    "    lines = path.read_text(encoding='utf-8').splitlines()\n"
    "else:\n"
    "    lines = []\n"
    "\n"
    "updated = []\n"
    "seen = set()\n"
    "for line in lines:\n"
    "    stripped = line.strip()\n"
    "    if stripped == '' or stripped.startswith('#') or '=' not in line:\n"
    "        updated.append(line)\n"
    "        continue\n"
    "    key, _value = line.split('=', 1)\n"
    "    key = key.strip()\n"
    "    if key in desired:\n"
    "        updated.append(f'{key}={desired[key]}')\n"
    "        seen.add(key)\n"
    "        continue\n"
    "    updated.append(line)\n"
    "\n"
    "for key, value in desired.items():\n"
    "    if key not in seen:\n"
    "        updated.append(f'{key}={value}')\n"
    "\n"
    "path.write_text('\\n'.join(updated).rstrip('\\n') + '\\n', encoding='utf-8')\n"
    "PY",
    f"chmod 600 {json.dumps(env_file)} || true",
    "grep -E "
    f"{json.dumps('^(SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME|INJECTION_JUDGE_FAIL_OPEN|OPENAI_INJECTION_HTTP_TIMEOUT_MS|INJECTION_JUDGE_TIMEOUT_MS)=')} "
    f"{json.dumps(env_file)}",
]

print(json.dumps({"commands": commands}))
PY
)"

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "Ensure dedicated app host env" \
    --parameters "$parameters_json" \
    --query 'Command.CommandId' \
    --output text
)"

echo "SSM env command started: ${command_id}"

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
