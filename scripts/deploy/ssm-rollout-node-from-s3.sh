#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ssm-rollout-node-from-s3.sh \
    --region ap-northeast-2 \
    --instance-id i-abc123 \
    --s3-bucket my-deploy-artifacts \
    [--s3-prefix wine-search-engine/direct] \
    [--release-id <custom-release-id>] \
    [--service-name wine-search-engine] \
    [--host-port 4000] \
    [--env-file /etc/wine-search-engine.env] \
    [--health-path /ready] \
    [--app-root /opt/wine-search-engine] \
    [--keep-releases 5] \
    [--run-migrate]

Behavior:
  1. Package the current working tree (tracked + non-ignored files only).
  2. Upload the source bundle to S3.
  3. Ask SSM to build and switch the release on the EC2 host.
  4. Restart a systemd service that runs `node dist/main.js`.

Host prerequisites:
  - SSM agent online on the target EC2 instance
  - aws CLI installed on the host
  - Node.js 22 + corepack available on the host
  - env file already present on the host
EOF
}

REGION=""
INSTANCE_ID=""
S3_BUCKET=""
S3_PREFIX="wine-search-engine/direct"
RELEASE_ID=""
SERVICE_NAME="wine-search-engine"
HOST_PORT="4000"
ENV_FILE="/etc/wine-search-engine.env"
HEALTH_PATH="/ready"
APP_ROOT="/opt/wine-search-engine"
KEEP_RELEASES="5"
RUN_MIGRATE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-prefix) S3_PREFIX="$2"; shift 2 ;;
    --release-id) RELEASE_ID="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
    --app-root) APP_ROOT="$2"; shift 2 ;;
    --keep-releases) KEEP_RELEASES="$2"; shift 2 ;;
    --run-migrate) RUN_MIGRATE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for key in REGION INSTANCE_ID S3_BUCKET; do
  if [[ -z "${!key}" ]]; then
    echo "Missing required argument: ${key}" >&2
    usage
    exit 1
  fi
done

case "$KEEP_RELEASES" in
  ''|*[!0-9]*)
    echo "--keep-releases must be a non-negative integer" >&2
    exit 1
    ;;
esac

for cmd in aws git python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required local command: $cmd" >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
git_sha="$(git -C "$repo_root" rev-parse --short=12 HEAD 2>/dev/null || true)"
if [[ -z "$RELEASE_ID" ]]; then
  if [[ -n "$git_sha" ]]; then
    RELEASE_ID="${git_sha}-${timestamp}"
  else
    RELEASE_ID="${timestamp}"
  fi
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
git_paths_path="${tmpdir}/git-paths.bin"
filelist_path="${tmpdir}/bundle-files.json"
bundle_path="${tmpdir}/${RELEASE_ID}.tar.gz"

git -C "$repo_root" ls-files -z --cached --others --exclude-standard > "$git_paths_path"

python3 - "$repo_root" "$git_paths_path" "$filelist_path" "$bundle_path" <<'PY'
import pathlib
import json
import tarfile
import sys

repo_root = pathlib.Path(sys.argv[1]).resolve()
git_paths_path = pathlib.Path(sys.argv[2])
output_path = pathlib.Path(sys.argv[3])
bundle_path = pathlib.Path(sys.argv[4])
raw = git_paths_path.read_bytes()
paths = [p.decode("utf-8") for p in raw.split(b"\0") if p]
excluded_prefixes = (
    ".git/",
    ".claude/",
    "node_modules/",
    "web/node_modules/",
    "dist/",
    "coverage/",
    "test-results/",
    "playwright-report/",
    "web/.next/",
)
excluded_exact = {
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".DS_Store",
}
seen = set()
kept = []
for rel in paths:
    rel = rel.strip()
    if not rel or rel in seen:
        continue
    if rel in excluded_exact:
        continue
    if any(rel.startswith(prefix) for prefix in excluded_prefixes):
        continue
    if rel.startswith(".env."):
        continue
    abs_path = repo_root / rel
    if not abs_path.exists():
        continue
    kept.append(rel)
    seen.add(rel)
if not kept:
    raise SystemExit("No deployable files were selected for the source bundle.")
output_path.write_text(json.dumps(kept), encoding="utf-8")

with tarfile.open(bundle_path, "w:gz") as archive:
    for rel in kept:
        archive.add(repo_root / rel, arcname=rel, recursive=True)
PY

if [[ ! -s "$filelist_path" ]]; then
  echo "Bundle file list is empty; aborting." >&2
  exit 1
fi

s3_key="${S3_PREFIX%/}/${RELEASE_ID}.tar.gz"
s3_key="${s3_key#/}"
s3_uri="s3://${S3_BUCKET}/${s3_key}"

echo "Uploading source bundle to ${s3_uri}"
aws s3 cp "$bundle_path" "$s3_uri"

tmpfile="$(mktemp)"
trap 'rm -rf "$tmpdir"; rm -f "$tmpfile"' EXIT

REGION="$REGION" \
S3_URI="$s3_uri" \
RELEASE_ID="$RELEASE_ID" \
SERVICE_NAME="$SERVICE_NAME" \
HOST_PORT="$HOST_PORT" \
ENV_FILE="$ENV_FILE" \
HEALTH_PATH="$HEALTH_PATH" \
APP_ROOT="$APP_ROOT" \
KEEP_RELEASES="$KEEP_RELEASES" \
RUN_MIGRATE="$RUN_MIGRATE" \
python3 - "$tmpfile" <<'PY'
import json
import os
import sys

path = sys.argv[1]
service_name = os.environ["SERVICE_NAME"]
app_root = os.environ["APP_ROOT"]
commands = [
    "set -eu",
    f"AWS_REGION='{os.environ['REGION']}'",
    f"S3_URI='{os.environ['S3_URI']}'",
    f"RELEASE_ID='{os.environ['RELEASE_ID']}'",
    f"SERVICE_NAME='{service_name}'",
    f"HOST_PORT='{os.environ['HOST_PORT']}'",
    f"ENV_FILE='{os.environ['ENV_FILE']}'",
    f"HEALTH_PATH='{os.environ['HEALTH_PATH']}'",
    f"APP_ROOT='{app_root}'",
    f"KEEP_RELEASES='{os.environ['KEEP_RELEASES']}'",
    f"RUN_MIGRATE='{os.environ['RUN_MIGRATE']}'",
    'APP_USER="$SERVICE_NAME"',
    'APP_GROUP="$SERVICE_NAME"',
    'APP_HOME="/var/lib/$SERVICE_NAME"',
    'RELEASES_DIR="$APP_ROOT/releases"',
    'RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"',
    'CURRENT_LINK="$APP_ROOT/current"',
    'DATA_DIR="$APP_ROOT/data"',
    'BUILD_DIR="$APP_ROOT/build"',
    'BUNDLE_PATH="/tmp/$SERVICE_NAME-$RELEASE_ID.tar.gz"',
    'UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"',
    'PREVIOUS_TARGET=""',
    'if [ ! -f "$ENV_FILE" ]; then echo "Missing env file: $ENV_FILE" >&2; exit 1; fi',
    'if ! command -v aws >/dev/null 2>&1; then echo "aws CLI missing on host" >&2; exit 1; fi',
    'if ! command -v node >/dev/null 2>&1; then echo "node missing on host; install Node 22 first" >&2; exit 1; fi',
    'if ! command -v corepack >/dev/null 2>&1; then echo "corepack missing on host; install Node 22 first" >&2; exit 1; fi',
    'NODE_MAJOR="$(node -p \'process.versions.node.split(".")[0]\')"',
    'if [ "$NODE_MAJOR" != "22" ]; then echo "Node 22 required on host; found $(node -v)" >&2; exit 1; fi',
    'NODE_BIN="$(command -v node)"',
    'if ! getent group "$APP_GROUP" >/dev/null 2>&1; then groupadd --system "$APP_GROUP"; fi',
    'if ! id "$APP_USER" >/dev/null 2>&1; then useradd --system --gid "$APP_GROUP" --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null || useradd --system --gid "$APP_GROUP" --home-dir "$APP_HOME" --create-home "$APP_USER"; fi',
    'mkdir -p "$APP_ROOT" "$RELEASES_DIR" "$DATA_DIR" "$BUILD_DIR" "$APP_HOME"',
    'chown -R "$APP_USER:$APP_GROUP" "$APP_HOME" "$DATA_DIR"',
    'aws s3 cp "$S3_URI" "$BUNDLE_PATH" --region "$AWS_REGION"',
    'rm -rf "$RELEASE_DIR"',
    'mkdir -p "$RELEASE_DIR"',
    'tar -xzf "$BUNDLE_PATH" -C "$RELEASE_DIR"',
    'corepack enable >/dev/null 2>&1 || true',
    'cd "$RELEASE_DIR"',
    'WINE_DATA_DIR="$DATA_DIR" WINE_BUILD_DIR="$BUILD_DIR" pnpm install --frozen-lockfile',
    'WINE_DATA_DIR="$DATA_DIR" WINE_BUILD_DIR="$BUILD_DIR" pnpm run build',
    'chmod -R a+rX "$RELEASE_DIR" "$BUILD_DIR"',
    'if [ "$RUN_MIGRATE" = "1" ]; then set -a; . "$ENV_FILE"; set +a; WINE_DATA_DIR="$DATA_DIR" WINE_BUILD_DIR="$BUILD_DIR" pnpm run migrate; fi',
    'if [ -L "$CURRENT_LINK" ] || [ -e "$CURRENT_LINK" ]; then PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" || true)"; fi',
    "cat > \"$UNIT_PATH\" <<EOF\n[Unit]\nDescription=Wine Search Engine\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=$APP_USER\nGroup=$APP_GROUP\nWorkingDirectory=$CURRENT_LINK\nEnvironmentFile=$ENV_FILE\nEnvironment=PORT=$HOST_PORT\nEnvironment=HOME=$APP_HOME\nExecStart=$NODE_BIN $CURRENT_LINK/dist/main.js\nRestart=always\nRestartSec=5\nTimeoutStopSec=30\nKillSignal=SIGTERM\nLimitNOFILE=65535\n\n[Install]\nWantedBy=multi-user.target\nEOF",
    'systemctl daemon-reload',
    'systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true',
    'ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"',
    'systemctl restart "$SERVICE_NAME"',
    'deadline=$(( $(date +%s) + 120 ))',
    'healthy=0',
    'while [ "$(date +%s)" -lt "$deadline" ]; do',
    '  if curl -fsS "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$HOST_PORT$HEALTH_PATH" >/dev/null 2>&1; then healthy=1; break; fi',
    '  sleep 3',
    'done',
    'if [ "$healthy" = "1" ]; then rm -f "$BUNDLE_PATH"; else',
    '  echo "Health check failed for $SERVICE_NAME on :$HOST_PORT$HEALTH_PATH" >&2',
    '  journalctl -u "$SERVICE_NAME" --no-pager -n 200 >&2 || true',
    '  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then',
    '    ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"',
    '    systemctl restart "$SERVICE_NAME" || true',
    '  fi',
    '  exit 1',
    'fi',
    'if [ "$KEEP_RELEASES" -gt 0 ]; then',
    '  STALE_LIST="/tmp/$SERVICE_NAME-stale-$RELEASE_ID.txt"',
    '  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf "%T@ %p\n" | sort -nr | awk -v keep="$KEEP_RELEASES" \'NR > keep { print $2 }\' > "$STALE_LIST"',
    '  if [ -s "$STALE_LIST" ]; then',
    '    while IFS= read -r stale_dir; do',
    '      [ -n "$stale_dir" ] || continue',
    '      rm -rf "$stale_dir"',
    '    done < "$STALE_LIST"',
    '  fi',
    '  rm -f "$STALE_LIST"',
    'fi',
    'echo "Direct deploy complete: release=$RELEASE_ID port=$HOST_PORT"',
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Direct deploy ${SERVICE_NAME}:${RELEASE_ID}" \
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
