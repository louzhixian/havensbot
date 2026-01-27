#!/usr/bin/env bash
set -euo pipefail

echo "Running prisma migrate deploy"

npx prisma migrate deploy

exec node dist/index.js
