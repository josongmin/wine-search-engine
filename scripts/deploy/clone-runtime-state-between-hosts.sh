#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  clone-runtime-state-between-hosts.sh \
    --region ap-northeast-2 \
    --source-instance-id i-shared-host \
    --target-instance-id i-dedicated-host \
    --s3-bucket codex-harry-temp-artifacts-527687867704

Options:
  --s3-prefix wine-search-engine/runtime-state
  --env-file /etc/wine-search-engine.env
  --data-dir /opt/wine-search-engine/data
  --keep-artifact
EOF
}

REGION=""
SOURCE_INSTANCE_ID=""
TARGET_INSTANCE_ID=""
S3_BUCKET=""
S3_PREFIX="wine-search-engine/runtime-state"
ENV_FILE="/etc/wine-search-engine.env"
DATA_DIR="/opt/wine-search-engine/data"
KEEP_ARTIFACT="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --source-instance-id) SOURCE_INSTANCE_ID="$2"; shift 2 ;;
    --target-instance-id) TARGET_INSTANCE_ID="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-prefix) S3_PREFIX="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --keep-artifact) KEEP_ARTIFACT="true"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for key in REGION SOURCE_INSTANCE_ID TARGET_INSTANCE_ID S3_BUCKET; do
  if [[ -z "${!key}" ]]; then
    echo "Missing required argument: ${key}" >&2
    usage
    exit 1
  fi
done

OBJECT_KEY="${S3_PREFIX%/}/runtime-state-${SOURCE_INSTANCE_ID}-${TARGET_INSTANCE_ID}-$(date -u +%Y%m%dT%H%M%SZ).tgz"
ARTIFACT_URI="s3://${S3_BUCKET}/${OBJECT_KEY}"

poll_command() {
  local region="$1"
  local instance_id="$2"
  local command_id="$3"
  local status=""

  for _ in $(seq 1 120); do
    status="$(
      aws ssm get-command-invocation \
        --region "$region" \
        --command-id "$command_id" \
        --instance-id "$instance_id" \
        --query 'Status' \
        --output text 2>/dev/null || true
    )"
    case "$status" in
      Success)
        aws ssm get-command-invocation \
          --region "$region" \
          --command-id "$command_id" \
          --instance-id "$instance_id" \
          --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        return 0
        ;;
      Cancelled|TimedOut|Failed|Cancelling)
        aws ssm get-command-invocation \
          --region "$region" \
          --command-id "$command_id" \
          --instance-id "$instance_id" \
          --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        return 1
        ;;
    esac
    sleep 5
  done

  echo "Timed out waiting for SSM command: $command_id" >&2
  return 1
}

send_ssm_json() {
  local region="$1"
  local instance_id="$2"
  local comment="$3"
  local json_file="$4"

  aws ssm send-command \
    --region "$region" \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --comment "$comment" \
    --parameters "file://${json_file}" \
    --query 'Command.CommandId' \
    --output text
}

tmp_source="$(mktemp)"
tmp_target="$(mktemp)"
trap 'rm -f "$tmp_source" "$tmp_target"' EXIT

ARTIFACT_URI="$ARTIFACT_URI" \
ENV_FILE="$ENV_FILE" \
DATA_DIR="$DATA_DIR" \
python - "$tmp_source" <<'PY'
import json
import os
import sys

path = sys.argv[1]
env_file = os.environ["ENV_FILE"]
data_dir = os.environ["DATA_DIR"]
commands = [
    "set -eu",
    f"ARTIFACT_URI='{os.environ['ARTIFACT_URI']}'",
    f"ENV_FILE='{env_file}'",
    f"DATA_DIR='{data_dir}'",
    'SNAPSHOT_FILE="$DATA_DIR/runtime-search-snapshot.json"',
    'MAPPINGS_FILE="$DATA_DIR/nl-mappings.json"',
    'for required in "$ENV_FILE" "$SNAPSHOT_FILE" "$MAPPINGS_FILE"; do if [ ! -f "$required" ]; then echo "Missing required file: $required" >&2; exit 1; fi; done',
    'ARCHIVE_PATH="/tmp/wine-search-engine-runtime-state.tgz"',
    'tar -C / -czf "$ARCHIVE_PATH" "${ENV_FILE#/}" "${SNAPSHOT_FILE#/}" "${MAPPINGS_FILE#/}"',
    'aws s3 cp "$ARCHIVE_PATH" "$ARTIFACT_URI" --sse AES256',
    'rm -f "$ARCHIVE_PATH"',
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

source_command_id="$(send_ssm_json "$REGION" "$SOURCE_INSTANCE_ID" "Export wine-search-engine runtime state" "$tmp_source")"
poll_command "$REGION" "$SOURCE_INSTANCE_ID" "$source_command_id" >/dev/null

ARTIFACT_URI="$ARTIFACT_URI" \
ENV_FILE="$ENV_FILE" \
DATA_DIR="$DATA_DIR" \
python - "$tmp_target" <<'PY'
import json
import os
import sys

path = sys.argv[1]
env_file = os.environ["ENV_FILE"]
data_dir = os.environ["DATA_DIR"]
commands = [
    "set -eu",
    f"ARTIFACT_URI='{os.environ['ARTIFACT_URI']}'",
    f"ENV_FILE='{env_file}'",
    f"DATA_DIR='{data_dir}'",
    'SNAPSHOT_FILE="$DATA_DIR/runtime-search-snapshot.json"',
    'MAPPINGS_FILE="$DATA_DIR/nl-mappings.json"',
    'ARCHIVE_PATH="/tmp/wine-search-engine-runtime-state.tgz"',
    'mkdir -p "$DATA_DIR"',
    'aws s3 cp "$ARTIFACT_URI" "$ARCHIVE_PATH"',
    'STAMP="$(date +%Y%m%d%H%M%S)"',
    'for existing in "$ENV_FILE" "$SNAPSHOT_FILE" "$MAPPINGS_FILE"; do if [ -f "$existing" ]; then cp "$existing" "$existing.$STAMP.bak"; fi; done',
    'tar -C / -xzf "$ARCHIVE_PATH"',
    'chmod 600 "$ENV_FILE"',
    'rm -f "$ARCHIVE_PATH"',
    'for required in "$ENV_FILE" "$SNAPSHOT_FILE" "$MAPPINGS_FILE"; do if [ ! -f "$required" ]; then echo "Missing restored file: $required" >&2; exit 1; fi; done',
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

target_command_id="$(send_ssm_json "$REGION" "$TARGET_INSTANCE_ID" "Import wine-search-engine runtime state" "$tmp_target")"
poll_command "$REGION" "$TARGET_INSTANCE_ID" "$target_command_id" >/dev/null

if [[ "$KEEP_ARTIFACT" != "true" ]]; then
  aws s3 rm "$ARTIFACT_URI" >/dev/null
fi

python - "$ARTIFACT_URI" "$KEEP_ARTIFACT" "$source_command_id" "$target_command_id" <<'PY'
import json
import sys

print(
    json.dumps(
        {
            "artifactUri": sys.argv[1],
            "keptArtifact": sys.argv[2] == "true",
            "sourceCommandId": sys.argv[3],
            "targetCommandId": sys.argv[4],
        }
    )
)
PY
