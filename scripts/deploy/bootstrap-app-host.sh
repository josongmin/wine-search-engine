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

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg docker.io awscli
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
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote template env file: $ENV_FILE"
fi

cat <<EOF
Bootstrap complete.

- docker: $(command -v docker)
- aws: $(command -v aws)
- env file: $ENV_FILE
- container name: $CONTAINER_NAME
- host port: $HOST_PORT
- app port: $APP_PORT

Next:
1. Fill $ENV_FILE with real runtime secrets.
2. Ensure the EC2 instance role can pull from ECR.
3. Run the GitHub/AWS bootstrap script from your workstation.
EOF
