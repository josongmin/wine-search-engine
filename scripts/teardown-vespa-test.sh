#!/usr/bin/env bash
set -euo pipefail
echo "🧹 Tearing down Vespa test environment..."
docker compose -f docker-compose.test.yml down --volumes --remove-orphans
echo "✅ Done"
