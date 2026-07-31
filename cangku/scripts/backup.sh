#!/bin/sh
set -eu

backup_dir="${BACKUP_DIR:-/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/cangku-${timestamp}.dump"
temporary="${target}.tmp"

mkdir -p "$backup_dir"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="${POSTGRES_HOST:-postgres}" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$temporary"
mv "$temporary" "$target"
sha256sum "$target" > "${target}.sha256"
printf 'backup_created=%s\n' "$target"
