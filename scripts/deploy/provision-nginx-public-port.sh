#!/usr/bin/env bash
set -euo pipefail

PUBLIC_PORT="${PUBLIC_PORT:-9011}"
UPSTREAM_HOST="${UPSTREAM_HOST:-127.0.0.1}"
UPSTREAM_PORT="${UPSTREAM_PORT:-4000}"
SERVER_NAMES="${SERVER_NAMES:-asommguide.shop shop.asommguide.com}"
CERT_BASE="${CERT_BASE:-/etc/letsencrypt/live/asommguide.shop}"
CONF_PATH="${CONF_PATH:-/etc/nginx/sites-available/wine-search-engine-public.conf}"
ENABLED_PATH="${ENABLED_PATH:-/etc/nginx/sites-enabled/wine-search-engine-public.conf}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ ! -f "${CERT_BASE}/fullchain.pem" || ! -f "${CERT_BASE}/privkey.pem" ]]; then
  echo "Missing certificate files under ${CERT_BASE}" >&2
  exit 1
fi

cat > "${CONF_PATH}" <<EOF
server {
    listen ${PUBLIC_PORT} ssl http2;
    server_name ${SERVER_NAMES};

    ssl_certificate ${CERT_BASE}/fullchain.pem;
    ssl_certificate_key ${CERT_BASE}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/wine-search-engine-access.log;
    error_log /var/log/nginx/wine-search-engine-error.log;

    location / {
        proxy_pass http://${UPSTREAM_HOST}:${UPSTREAM_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        client_max_body_size 25M;
    }
}
EOF

ln -sfn "${CONF_PATH}" "${ENABLED_PATH}"
nginx -t
systemctl reload nginx

cat <<EOF
Provisioned nginx public route.

- public port: ${PUBLIC_PORT}
- upstream: ${UPSTREAM_HOST}:${UPSTREAM_PORT}
- server names: ${SERVER_NAMES}
- config: ${CONF_PATH}
EOF
