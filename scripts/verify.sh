#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "verify failed: .env not found" >&2
  exit 1
fi

get_env_value() {
  local key="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -m1 "^${key}=" .env | sed "s/^${key}=//"
  else
    grep -m1 "^${key}=" .env | sed "s/^${key}=//"
  fi
}

POSTGRES_USER="$(get_env_value "POSTGRES_USER")"
POSTGRES_DB="$(get_env_value "POSTGRES_DB")"

if [ -z "$POSTGRES_USER" ] || [ -z "$POSTGRES_DB" ]; then
  echo "verify failed: POSTGRES_USER/POSTGRES_DB missing in .env" >&2
  exit 1
fi

docker compose version >/dev/null
docker compose config >/dev/null
docker compose ps >/dev/null

docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
docker compose exec -T app node dist/verify.js
