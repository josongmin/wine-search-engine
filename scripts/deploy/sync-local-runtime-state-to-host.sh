#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sync-local-runtime-state-to-host.sh \
    [--region ap-northeast-2] \
    [--instance-id i-0e28f63452c548a9f] \
    [--s3-bucket codex-harry-temp-artifacts-527687867704] \
    [--s3-prefix wine-search-engine/local-runtime-state] \
    [--local-data-dir ~/.wine-search-engine/data] \
    [--data-dir /opt/wine-search-engine/data]
EOF
}

REGION="ap-northeast-2"
INSTANCE_ID="i-0e28f63452c548a9f"
S3_BUCKET="codex-harry-temp-artifacts-527687867704"
S3_PREFIX="wine-search-engine/local-runtime-state"
LOCAL_DATA_DIR="${HOME}/.wine-search-engine/data"
DATA_DIR="/opt/wine-search-engine/data"
KEEP_ARTIFACT="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-prefix) S3_PREFIX="$2"; shift 2 ;;
    --local-data-dir) LOCAL_DATA_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --keep-artifact) KEEP_ARTIFACT="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

RUNTIME_STATE_PATH="${LOCAL_DATA_DIR}/runtime-search-snapshot.json"
NL_MAPPINGS_PATH="${LOCAL_DATA_DIR}/nl-mappings.json"

for required in "$RUNTIME_STATE_PATH" "$NL_MAPPINGS_PATH"; do
  if [[ ! -f "$required" ]]; then
    echo "Missing required local file: $required" >&2
    exit 1
  fi
done

eval "$(
  node -e '
    const fs = require("fs");
    const path = require("path");
    const runtime = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof runtime.snapshotId !== "string" || runtime.snapshotId.length === 0) {
      throw new Error("runtime-search-snapshot.json missing snapshotId");
    }
    if (typeof runtime.manifestPath !== "string" || runtime.manifestPath.length === 0) {
      throw new Error("runtime-search-snapshot.json missing manifestPath");
    }
    const snapshotDir = path.dirname(runtime.manifestPath);
    process.stdout.write(`SNAPSHOT_ID=${JSON.stringify(runtime.snapshotId)}\n`);
    process.stdout.write(`SNAPSHOT_DIR=${JSON.stringify(snapshotDir)}\n`);
  ' "$RUNTIME_STATE_PATH"
)"

if [[ ! -d "$SNAPSHOT_DIR" ]]; then
  echo "Missing local snapshot directory: $SNAPSHOT_DIR" >&2
  exit 1
fi

archive_path="$(mktemp /tmp/wine-search-runtime.XXXXXX.tgz)"
tmpfile="$(mktemp)"
trap 'rm -f "$archive_path" "$tmpfile"' EXIT

OBJECT_KEY="${S3_PREFIX%/}/runtime-state-${INSTANCE_ID}-$(date -u +%Y%m%dT%H%M%SZ).tgz"
ARTIFACT_URI="s3://${S3_BUCKET}/${OBJECT_KEY}"

snapshot_parent="$(dirname "$SNAPSHOT_DIR")"
snapshot_leaf="$(basename "$SNAPSHOT_DIR")"

COPYFILE_DISABLE=1 tar -C "$LOCAL_DATA_DIR" -czf "$archive_path" \
  runtime-search-snapshot.json \
  nl-mappings.json \
  "search-snapshots/${snapshot_leaf}"

aws s3 cp "$archive_path" "$ARTIFACT_URI" --sse AES256 >/dev/null

ARTIFACT_URI="$ARTIFACT_URI" \
DATA_DIR="$DATA_DIR" \
python - "$tmpfile" <<'PY'
import json
import os
import sys

path = sys.argv[1]
commands = [
    "set -eu",
    f"ARTIFACT_URI='{os.environ['ARTIFACT_URI']}'",
    f"DATA_DIR='{os.environ['DATA_DIR']}'",
    'ARCHIVE_PATH="/tmp/wine-search-engine-runtime-state.tgz"',
    'mkdir -p "$DATA_DIR"',
    'aws s3 cp "$ARTIFACT_URI" "$ARCHIVE_PATH"',
    'tar -C "$DATA_DIR" -xzf "$ARCHIVE_PATH"',
    'rm -f "$ARCHIVE_PATH"',
    'test -f "$DATA_DIR/runtime-search-snapshot.json"',
    'test -f "$DATA_DIR/nl-mappings.json"',
    'find "$DATA_DIR/search-snapshots" -maxdepth 2 -name manifest.json | head -n 1 >/dev/null',
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Import runtime payload" \
    --parameters "file://${tmpfile}" \
    --query 'Command.CommandId' \
    --output text
)"

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

if [[ "$KEEP_ARTIFACT" != "true" ]]; then
  aws s3 rm "$ARTIFACT_URI" >/dev/null
fi

aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
