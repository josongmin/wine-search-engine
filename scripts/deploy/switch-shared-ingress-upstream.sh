#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  switch-shared-ingress-upstream.sh \
    --region ap-northeast-2 \
    --instance-id i-shared-ingress \
    --upstream-host 172.31.x.y

Options:
  --public-port 9011
  --upstream-port 4000
  --server-names "asommguide.shop shop.asommguide.com"
  --cert-base /etc/letsencrypt/live/asommguide.shop
  --conf-path /etc/nginx/sites-available/wine-search-engine-public.conf
  --enabled-path /etc/nginx/sites-enabled/wine-search-engine-public.conf
EOF
}

REGION=""
INSTANCE_ID=""
UPSTREAM_HOST=""
PUBLIC_PORT="9011"
UPSTREAM_PORT="4000"
SERVER_NAMES="asommguide.shop shop.asommguide.com"
CERT_BASE="/etc/letsencrypt/live/asommguide.shop"
CONF_PATH="/etc/nginx/sites-available/wine-search-engine-public.conf"
ENABLED_PATH="/etc/nginx/sites-enabled/wine-search-engine-public.conf"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --upstream-host) UPSTREAM_HOST="$2"; shift 2 ;;
    --public-port) PUBLIC_PORT="$2"; shift 2 ;;
    --upstream-port) UPSTREAM_PORT="$2"; shift 2 ;;
    --server-names) SERVER_NAMES="$2"; shift 2 ;;
    --cert-base) CERT_BASE="$2"; shift 2 ;;
    --conf-path) CONF_PATH="$2"; shift 2 ;;
    --enabled-path) ENABLED_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for key in REGION INSTANCE_ID UPSTREAM_HOST; do
  if [[ -z "${!key}" ]]; then
    echo "Missing required argument: ${key}" >&2
    usage
    exit 1
  fi
done

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

PROVISION_SCRIPT_B64="$(
  base64 < "$(dirname "$0")/provision-nginx-public-port.sh" | tr -d '\n'
)"
PROVISION_SCRIPT_B64="$PROVISION_SCRIPT_B64" \
PUBLIC_PORT="$PUBLIC_PORT" \
UPSTREAM_HOST="$UPSTREAM_HOST" \
UPSTREAM_PORT="$UPSTREAM_PORT" \
SERVER_NAMES="$SERVER_NAMES" \
CERT_BASE="$CERT_BASE" \
CONF_PATH="$CONF_PATH" \
ENABLED_PATH="$ENABLED_PATH" \
python - "$tmpfile" <<'PY'
import json
import os
import sys

path = sys.argv[1]
commands = [
    "set -eu",
    f"PROVISION_SCRIPT_B64='{os.environ['PROVISION_SCRIPT_B64']}'",
    "printf '%s' \"$PROVISION_SCRIPT_B64\" | base64 -d >/tmp/provision-nginx-public-port.sh",
    "chmod +x /tmp/provision-nginx-public-port.sh",
    (
        f"PUBLIC_PORT='{os.environ['PUBLIC_PORT']}' "
        f"UPSTREAM_HOST='{os.environ['UPSTREAM_HOST']}' "
        f"UPSTREAM_PORT='{os.environ['UPSTREAM_PORT']}' "
        f"SERVER_NAMES='{os.environ['SERVER_NAMES']}' "
        f"CERT_BASE='{os.environ['CERT_BASE']}' "
        f"CONF_PATH='{os.environ['CONF_PATH']}' "
        f"ENABLED_PATH='{os.environ['ENABLED_PATH']}' "
        "/tmp/provision-nginx-public-port.sh"
    ),
    f"sed -n '1,120p' '{os.environ['CONF_PATH']}'",
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Switch wine-search-engine ingress upstream" \
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

aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
