#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/wine-search-engine.env}"
CONTAINER_NAME="${CONTAINER_NAME:-wine-search-engine}"
HOST_PORT="${HOST_PORT:-4000}"
APP_PORT="${APP_PORT:-3000}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

install_aws_cli_v2() {
  if command -v aws >/dev/null 2>&1; then
    return 0
  fi

  local arch=""
  local tmpdir=""
  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)
      echo "Unsupported architecture for AWS CLI: $(uname -m)" >&2
      exit 1
      ;;
  esac

  tmpdir="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "${tmpdir}/awscliv2.zip"
  unzip -q "${tmpdir}/awscliv2.zip" -d "$tmpdir"
  "${tmpdir}/aws/install" --update
  rm -rf "$tmpdir"
}

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg docker.io unzip
  install_aws_cli_v2
  systemctl enable --now docker
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y docker awscli
  systemctl enable --now docker
elif command -v yum >/dev/null 2>&1; then
  yum install -y docker awscli
  systemctl enable --now docker
else
  echo "Unsupported package manager." >&2
  exit 1
fi

mkdir -p /opt/wine-search-engine
mkdir -p /opt/wine-search-engine/data

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
# Wine Search Engine runtime env
# Fill required secrets before first deploy.
NODE_ENV=production
PORT=${APP_PORT}

# Example core settings:
# DATABASE_URL=postgresql://...
# VESPA_URL=http://...
# OPENAI_API_KEY=...
# COHERE_API_KEY=...
# HTTP_DEBUG_SECRET=...
SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME=false
INJECTION_JUDGE_FAIL_OPEN=true
OPENAI_INJECTION_HTTP_TIMEOUT_MS=5000
INJECTION_JUDGE_TIMEOUT_MS=5000
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote template env file: $ENV_FILE"
fi

cat <<EOF
Bootstrap complete.

- docker: $(command -v docker)
- aws: $(command -v aws)
- env file: $ENV_FILE
- data dir: /opt/wine-search-engine/data
- container name: $CONTAINER_NAME
- host port: $HOST_PORT
- app port: $APP_PORT

Next:
1. Fill $ENV_FILE with real runtime secrets.
2. Ensure the EC2 instance role can pull from ECR.
3. Run the GitHub/AWS bootstrap script from your workstation.
EOF
